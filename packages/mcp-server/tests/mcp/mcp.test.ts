// MCP dispatch behaviour tests.
//
// Migrated from packages/mcp-server/tests/mcp.test.js as part of T4.2.
// Behaviour coverage is identical to the pre-migration suite — these
// tests exercise the tool registry, role gating, JSON-RPC error
// envelope, and resource visibility through `handleMcpPayload`.

import { handleMcpPayload } from "@librarian/mcp-server";
import { describe, expect, it } from "vitest";
import { withStore } from "../../../../test/helpers.js";

describe("MCP dispatch", () => {
  it("exposes the expected server identity and tool surface", async () => {
    await withStore(async (store) => {
      const init = (await handleMcpPayload(store, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      })) as { result: { serverInfo: { name: string } } };
      expect(init.result.serverInfo.name).toBe("the-librarian");

      const list = (await handleMcpPayload(store, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      })) as { result: { tools: { name: string }[] } };
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
        expect(toolNames).toContain(expected);
      }
      expect(toolNames).not.toContain("approve_proposal");
      expect(toolNames).not.toContain("delete_memory");
      expect(toolNames).not.toContain("resolve_conflict");

      const adminList = (await handleMcpPayload(
        store,
        { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
        { role: "admin" },
      )) as { result: { tools: { name: string }[] } };
      const adminToolNames = adminList.result.tools.map((tool) => tool.name);
      expect(adminToolNames).toContain("approve_proposal");
      expect(adminToolNames).toContain("delete_memory");
      expect(adminToolNames).toContain("resolve_conflict");
    });
  });

  it("remember protects identity memories and ordinary recall returns clean prose", async () => {
    await withStore(async (store) => {
      const protectedWrite = (await handleMcpPayload(store, {
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
      })) as { result: { content: { text: string }[] } };

      expect(protectedWrite.result.content[0].text).toMatch(/proposal for review/);
      expect(store.listAll({ status: "proposed" }).length).toBe(1);

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

      const recall = (await handleMcpPayload(store, {
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
      })) as { result: { content: { text: string }[] } };

      const text = recall.result.content[0].text;
      expect(text).toMatch(/Remote agents should POST JSON-RPC messages to \/mcp/);
      expect(text).not.toMatch(/mem_[a-f0-9-]+/);
    });
  });

  it("start_context always includes approved identity and relationship context", async () => {
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

      const context = (await handleMcpPayload(store, {
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
      })) as { result: { content: { text: string }[] } };

      const text = context.result.content[0].text;
      expect(text).toMatch(/Identity/);
      expect(text).toMatch(/portable memory system/);
      expect(text).toMatch(/Relationship/);
      expect(text).toMatch(/preserve continuity/);
    });
  });

  it("returns JSON-RPC errors for unknown methods instead of throwing outward", async () => {
    await withStore(async (store) => {
      const result = (await handleMcpPayload(store, {
        jsonrpc: "2.0",
        id: 99,
        method: "does/not/exist",
        params: {},
      })) as { id: number; error: { code: number; message: string } };

      expect(result.id).toBe(99);
      expect(result.error.code).toBe(-32000);
      expect(result.error.message).toMatch(/Unsupported method/);
    });
  });

  it("agent role cannot approve proposals or delete memories", async () => {
    await withStore(async (store) => {
      const proposal = store.createMemory({
        agent_id: "codex",
        title: "Protected identity proposal",
        body: "This must remain proposed until an admin approves it.",
        category: "identity",
        visibility: "common",
        scope: "global",
      });

      const approve = (await handleMcpPayload(store, {
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
      })) as { error: { message: string } };

      expect(approve.error.message).toMatch(/requires admin authorization/);
      expect(store.getMemory(proposal.memory.id).status).toBe("proposed");

      const ordinary = store.createMemory({
        agent_id: "codex",
        title: "Ordinary note",
        body: "An agent token should not be able to delete this.",
        category: "tools",
        visibility: "common",
        scope: "tool",
      });

      const deletion = (await handleMcpPayload(store, {
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
      })) as { error: { message: string } };

      expect(deletion.error.message).toMatch(/requires admin authorization/);
      expect(store.getMemory(ordinary.memory.id).status).toBe("active");
    });
  });

  it("memory resource does not leak other agents private memories", async () => {
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

      const sharedAgent = (await handleMcpPayload(store, {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "librarian://memories" },
      })) as { result: { contents: { text: string }[] } };
      const sharedText = sharedAgent.result.contents[0].text;
      expect(sharedText).toMatch(/Common memory/);
      expect(sharedText).not.toMatch(/Codex private memory/);
      expect(sharedText).not.toMatch(/Claude private memory/);

      const codexAgent = (await handleMcpPayload(
        store,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "resources/read",
          params: { uri: "librarian://memories" },
        },
        { role: "agent", agentId: "codex" },
      )) as { result: { contents: { text: string }[] } };
      const codexText = codexAgent.result.contents[0].text;
      expect(codexText).toMatch(/Common memory/);
      expect(codexText).toMatch(/Codex private memory/);
      expect(codexText).not.toMatch(/Claude private memory/);

      const admin = (await handleMcpPayload(
        store,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "resources/read",
          params: { uri: "librarian://memories" },
        },
        { role: "admin" },
      )) as { result: { contents: { text: string }[] } };
      const adminText = admin.result.contents[0].text;
      expect(adminText).toMatch(/Common memory/);
      expect(adminText).toMatch(/Codex private memory/);
      expect(adminText).toMatch(/Claude private memory/);
    });
  });
});
