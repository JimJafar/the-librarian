import test from "node:test";
import assert from "node:assert/strict";
import { handleMcpPayload } from "../src/mcp.js";
import { withStore } from "./helpers.js";

function callTool(store, name, args, context = {}) {
  return handleMcpPayload(
    store,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    context
  );
}

test("MCP tools/list exposes the session read-tool surface", async () => {
  await withStore(async (store) => {
    const list = await handleMcpPayload(store, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const names = list.result.tools.map((tool) => tool.name);
    for (const expected of ["start_session", "get_session", "list_sessions", "list_session_events", "search_sessions"]) {
      assert.ok(names.includes(expected), `expected ${expected} in tool list, got ${names.join(", ")}`);
    }
  });
});

test("MCP start_session creates a session attributed to the authenticated agent", async () => {
  await withStore(async (store) => {
    const response = await callTool(store, "start_session", {
      title: "MCP foundational test",
      harness: "hermes",
      project_key: "the-librarian",
      start_summary: "Investigating MCP tool surface."
    }, { role: "agent", agentId: "bede" });

    const text = response.result.content[0].text;
    assert.match(text, /ses_/, "session id should be returned");
    assert.match(text, /MCP foundational test/);

    const sessions = store.listSessions({ agent_id: "bede" }).sessions;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].created_by_agent_id, "bede");
    assert.equal(sessions[0].title, "MCP foundational test");
  });
});

test("MCP start_session refuses to honour a caller-supplied agent_id (no impersonation)", async () => {
  await withStore(async (store) => {
    await callTool(store, "start_session", {
      agent_id: "imposter",
      title: "Impersonation attempt",
      harness: "hermes"
    }, { role: "agent", agentId: "bede" });

    const sessions = store.listSessions({ agent_id: "bede" }).sessions;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].created_by_agent_id, "bede");
    assert.notEqual(sessions[0].created_by_agent_id, "imposter");
  });
});

test("MCP start_session output is clean prose and does not leak internal event ids", async () => {
  await withStore(async (store) => {
    const response = await callTool(store, "start_session", {
      title: "Cleanliness check",
      harness: "hermes"
    }, { role: "agent", agentId: "bede" });

    const text = response.result.content[0].text;
    assert.doesNotMatch(text, /sevt_/);
    assert.doesNotMatch(text, /evt_/);
  });
});

test("MCP list_sessions returns numbered selectable sessions and tells the agent to use session_id", async () => {
  await withStore(async (store) => {
    store.startSession({ agent_id: "bede", title: "First", harness: "hermes" });
    store.startSession({ agent_id: "bede", title: "Second", harness: "hermes" });

    const response = await callTool(store, "list_sessions", {}, { role: "agent", agentId: "bede" });
    const text = response.result.content[0].text;
    assert.match(text, /1\. /);
    assert.match(text, /2\. /);
    assert.match(text, /First/);
    assert.match(text, /Second/);
    assert.match(text, /session_id/i, "agent should be reminded to use the canonical session_id");
  });
});

test("MCP list_sessions does not include another agent's private sessions", async () => {
  await withStore(async (store) => {
    store.startSession({ agent_id: "bede", title: "Bede shared", harness: "hermes" });
    store.startSession({ agent_id: "codex", title: "Codex private", harness: "codex", visibility: "agent_private" });

    const response = await callTool(store, "list_sessions", {}, { role: "agent", agentId: "bede" });
    const text = response.result.content[0].text;
    assert.match(text, /Bede shared/);
    assert.doesNotMatch(text, /Codex private/);
  });
});

test("MCP get_session hides agent_private sessions from non-owner callers", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({
      agent_id: "codex",
      title: "Codex private session",
      harness: "codex",
      visibility: "agent_private"
    });

    const asBede = await callTool(
      store,
      "get_session",
      { session_id: session.id },
      { role: "agent", agentId: "bede" }
    );
    const bedeText = asBede.result.content[0].text;
    assert.doesNotMatch(bedeText, /Codex private session/);
    assert.match(bedeText, /not found|no session/i);

    const asCodex = await callTool(
      store,
      "get_session",
      { session_id: session.id },
      { role: "agent", agentId: "codex" }
    );
    assert.match(asCodex.result.content[0].text, /Codex private session/);
  });
});

test("MCP get_session admin can see another agent's private session", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({
      agent_id: "codex",
      title: "Codex private",
      harness: "codex",
      visibility: "agent_private"
    });
    const response = await callTool(
      store,
      "get_session",
      { session_id: session.id },
      { role: "admin" }
    );
    assert.match(response.result.content[0].text, /Codex private/);
  });
});

test("MCP list_session_events hides events from non-owners of agent_private sessions", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({
      agent_id: "codex",
      title: "Codex priv",
      harness: "codex",
      visibility: "agent_private"
    });
    store.recordSessionEvent({
      agent_id: "codex",
      session_id: session.id,
      type: "decision",
      summary: "Codex secret decision."
    });

    const asBede = await callTool(
      store,
      "list_session_events",
      { session_id: session.id },
      { role: "agent", agentId: "bede" }
    );
    const text = asBede.result.content[0].text;
    assert.doesNotMatch(text, /Codex secret decision/);
    assert.match(text, /not found|no session|no events/i);
  });
});

test("MCP search_sessions does not leak private content from other agents", async () => {
  await withStore(async (store) => {
    store.startSession({
      agent_id: "codex",
      title: "Codex BM25 work",
      harness: "codex",
      visibility: "agent_private",
      start_summary: "Investigate BM25 recall in private."
    });

    const asBede = await callTool(
      store,
      "search_sessions",
      { query: "BM25" },
      { role: "agent", agentId: "bede" }
    );
    const text = asBede.result.content[0].text;
    assert.doesNotMatch(text, /Codex BM25/);
  });
});
