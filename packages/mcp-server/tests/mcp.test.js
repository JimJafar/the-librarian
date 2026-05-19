import assert from "node:assert/strict";
import test from "node:test";
import { withStore } from "../../../test/helpers.js";
import { handleMcpPayload } from "../src/mcp/dispatch.js";

test("MCP exposes the expected server identity and tool surface", async () => {
  await withStore(async (store) => {
    const init = await handleMcpPayload(store, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    assert.equal(init.result.serverInfo.name, "the-librarian");

    const list = await handleMcpPayload(store, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const toolNames = list.result.tools.map((tool) => tool.name);
    for (const expected of [
      "start_context",
      "recall",
      "remember",
      "propose_memory",
      "update_memory",
      "verify_memory",
      "list_proposals",
    ]) {
      assert.ok(toolNames.includes(expected), `expected memory tool ${expected}`);
    }
    assert.ok(!toolNames.includes("approve_proposal"));
    assert.ok(!toolNames.includes("delete_memory"));
    assert.ok(!toolNames.includes("resolve_conflict"));

    const adminList = await handleMcpPayload(
      store,
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      { role: "admin" },
    );
    const adminToolNames = adminList.result.tools.map((tool) => tool.name);
    assert.ok(adminToolNames.includes("approve_proposal"));
    assert.ok(adminToolNames.includes("delete_memory"));
    assert.ok(adminToolNames.includes("resolve_conflict"));
  });
});

test("MCP remember protects identity memories and ordinary recall returns clean prose", async () => {
  await withStore(async (store) => {
    const protectedWrite = await handleMcpPayload(store, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "remember",
        arguments: {
          agent_id: "codex",
          title: "User wants reviewed identity",
          body: "Identity memories should be reviewed before activation.",
          category: "identity",
          visibility: "common",
          scope: "global",
          priority: "core",
        },
      },
    });

    assert.match(protectedWrite.result.content[0].text, /proposal for review/);
    assert.equal(store._listAll({ status: "proposed" }).length, 1);

    await handleMcpPayload(store, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "remember",
        arguments: {
          agent_id: "codex",
          title: "MCP endpoint path",
          body: "Remote agents should POST JSON-RPC messages to /mcp.",
          category: "tools",
          visibility: "common",
          scope: "tool",
          tags: ["mcp", "http"],
        },
      },
    });

    const recall = await handleMcpPayload(store, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "recall",
        arguments: {
          agent_id: "codex",
          query: "remote agents POST JSON-RPC",
          categories: ["tools"],
          limit: 3,
        },
      },
    });

    const text = recall.result.content[0].text;
    assert.match(text, /Remote agents should POST JSON-RPC messages to \/mcp/);
    assert.doesNotMatch(text, /mem_[a-f0-9-]+/);
  });
});

test("MCP start_context always includes approved identity and relationship context", async () => {
  await withStore(async (store) => {
    const identity = store.createMemory({
      agent_id: "dashboard",
      title: "User identity baseline",
      body: "The user is building a portable memory system for agents.",
      category: "identity",
      visibility: "common",
      scope: "global",
      priority: "core",
    });
    const relationship = store.createMemory({
      agent_id: "dashboard",
      title: "Relationship baseline",
      body: "The user wants memory behavior to preserve continuity without noisy bookkeeping.",
      category: "relationship",
      visibility: "common",
      scope: "global",
      priority: "core",
    });
    store.approveProposal(identity.memory.id, "approve", {}, "dashboard");
    store.approveProposal(relationship.memory.id, "approve", {}, "dashboard");

    const context = await handleMcpPayload(store, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "start_context",
        arguments: {
          agent_id: "codex",
          task_summary: "write deployment tests",
        },
      },
    });

    const text = context.result.content[0].text;
    assert.match(text, /Identity/);
    assert.match(text, /portable memory system/);
    assert.match(text, /Relationship/);
    assert.match(text, /preserve continuity/);
  });
});

test("MCP returns JSON-RPC errors for unknown methods instead of throwing outward", async () => {
  await withStore(async (store) => {
    const result = await handleMcpPayload(store, {
      jsonrpc: "2.0",
      id: 99,
      method: "does/not/exist",
      params: {},
    });

    assert.equal(result.id, 99);
    assert.equal(result.error.code, -32000);
    assert.match(result.error.message, /Unsupported method/);
  });
});

test("MCP agent role cannot approve proposals or delete memories", async () => {
  await withStore(async (store) => {
    const proposal = store.createMemory({
      agent_id: "codex",
      title: "Protected identity proposal",
      body: "This must remain proposed until an admin approves it.",
      category: "identity",
      visibility: "common",
      scope: "global",
    });

    const approve = await handleMcpPayload(store, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "approve_proposal",
        arguments: {
          agent_id: "codex",
          memory_id: proposal.memory.id,
        },
      },
    });

    assert.match(approve.error.message, /requires admin authorization/);
    assert.equal(store.getMemory(proposal.memory.id).status, "proposed");

    const ordinary = store.createMemory({
      agent_id: "codex",
      title: "Ordinary note",
      body: "An agent token should not be able to delete this.",
      category: "tools",
      visibility: "common",
      scope: "tool",
    });

    const deletion = await handleMcpPayload(store, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "delete_memory",
        arguments: {
          agent_id: "codex",
          memory_id: ordinary.memory.id,
        },
      },
    });

    assert.match(deletion.error.message, /requires admin authorization/);
    assert.equal(store.getMemory(ordinary.memory.id).status, "active");
  });
});

test("MCP memory resource does not leak other agents private memories", async () => {
  await withStore(async (store) => {
    store.createMemory({
      agent_id: "dashboard",
      title: "Common memory",
      body: "Common memory should be visible through the resource.",
      category: "tools",
      visibility: "common",
      scope: "global",
    });
    store.createMemory({
      agent_id: "codex",
      title: "Codex private memory",
      body: "Codex should use pnpm for local workspace commands.",
      category: "tools",
      visibility: "agent_private",
      scope: "global",
    });
    store.createMemory({
      agent_id: "claude",
      title: "Claude private memory",
      body: "Claude should use uv for isolated Python command checks.",
      category: "tools",
      visibility: "agent_private",
      scope: "global",
    });

    const sharedAgent = await handleMcpPayload(store, {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: "librarian://memories" },
    });
    const sharedText = sharedAgent.result.contents[0].text;
    assert.match(sharedText, /Common memory/);
    assert.doesNotMatch(sharedText, /Codex private memory/);
    assert.doesNotMatch(sharedText, /Claude private memory/);

    const codexAgent = await handleMcpPayload(
      store,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "resources/read",
        params: { uri: "librarian://memories" },
      },
      { role: "agent", agentId: "codex" },
    );
    const codexText = codexAgent.result.contents[0].text;
    assert.match(codexText, /Common memory/);
    assert.match(codexText, /Codex private memory/);
    assert.doesNotMatch(codexText, /Claude private memory/);

    const admin = await handleMcpPayload(
      store,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "resources/read",
        params: { uri: "librarian://memories" },
      },
      { role: "admin" },
    );
    const adminText = admin.result.contents[0].text;
    assert.match(adminText, /Common memory/);
    assert.match(adminText, /Codex private memory/);
    assert.match(adminText, /Claude private memory/);
  });
});
