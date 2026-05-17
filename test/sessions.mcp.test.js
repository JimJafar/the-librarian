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

test("MCP tools/list exposes session mutation tools", async () => {
  await withStore(async (store) => {
    const list = await handleMcpPayload(store, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const names = list.result.tools.map((tool) => tool.name);
    for (const expected of [
      "record_session_event",
      "checkpoint_session",
      "pause_session",
      "end_session",
      "attach_session",
      "continue_session"
    ]) {
      assert.ok(names.includes(expected), `expected ${expected} in tool list`);
    }
  });
});

test("MCP record_session_event appends a typed event to a visible session", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({ agent_id: "bede", title: "Recordable", harness: "hermes" });

    const response = await callTool(
      store,
      "record_session_event",
      { session_id: session.id, type: "decision", summary: "Default attach=true." },
      { role: "agent", agentId: "bede" }
    );

    assert.match(response.result.content[0].text, /record|decision/i);
    const events = store.listSessionEvents({ session_id: session.id });
    assert.ok(events.events.some((event) => event.type === "decision" && event.summary === "Default attach=true."));
  });
});

test("MCP record_session_event refuses to mutate another agent's private session", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({
      agent_id: "codex",
      title: "Codex private",
      harness: "codex",
      visibility: "agent_private"
    });

    const response = await callTool(
      store,
      "record_session_event",
      { session_id: session.id, type: "note", summary: "I shouldn't be here." },
      { role: "agent", agentId: "bede" }
    );

    assert.match(response.result.content[0].text, /not found|no session/i);
    const events = store.listSessionEvents({ session_id: session.id });
    assert.ok(!events.events.some((event) => event.summary === "I shouldn't be here."));
  });
});

test("MCP checkpoint_session updates rolling_summary and keeps the session active", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({ agent_id: "bede", title: "Checkpointable", harness: "hermes" });

    const response = await callTool(
      store,
      "checkpoint_session",
      {
        session_id: session.id,
        summary: "Mid-progress snapshot.",
        next_steps: ["Wire MCP tools"]
      },
      { role: "agent", agentId: "bede" }
    );

    const text = response.result.content[0].text;
    assert.match(text, /checkpoint/i);
    const reloaded = store.getSession(session.id);
    assert.equal(reloaded.rolling_summary, "Mid-progress snapshot.");
    assert.equal(reloaded.status, "active");
  });
});

test("MCP pause_session marks the session paused", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({ agent_id: "bede", title: "Pausable", harness: "hermes" });

    const response = await callTool(
      store,
      "pause_session",
      { session_id: session.id, summary: "Stopping for the day." },
      { role: "agent", agentId: "bede" }
    );

    assert.match(response.result.content[0].text, /paused/i);
    const reloaded = store.getSession(session.id);
    assert.equal(reloaded.status, "paused");
    assert.equal(reloaded.rolling_summary, "Stopping for the day.");
  });
});

test("MCP end_session writes end_summary and marks the session ended", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({ agent_id: "bede", title: "Endable", harness: "hermes" });

    const response = await callTool(
      store,
      "end_session",
      { session_id: session.id, summary: "All done." },
      { role: "agent", agentId: "bede" }
    );

    assert.match(response.result.content[0].text, /ended/i);
    const reloaded = store.getSession(session.id);
    assert.equal(reloaded.status, "ended");
    assert.equal(reloaded.end_summary, "All done.");
  });
});

test("MCP attach_session updates the current harness and source_ref", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Attachable",
      harness: "hermes",
      source_ref: "discord:1:2"
    });

    await callTool(
      store,
      "attach_session",
      {
        session_id: session.id,
        harness: "codex",
        source_ref: "codex:r1:cwd:/dev",
        cwd: "/dev"
      },
      { role: "agent", agentId: "codex" }
    );

    const reloaded = store.getSession(session.id);
    assert.equal(reloaded.current_harness, "codex");
    assert.equal(reloaded.current_agent_id, "codex");
    assert.equal(reloaded.source_ref, "codex:r1:cwd:/dev");
    assert.equal(reloaded.created_in_harness, "hermes", "origin preserved");
  });
});

test("MCP continue_session returns a handover package and (default) attaches", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Handover via MCP",
      harness: "hermes",
      project_key: "the-librarian",
      start_summary: "Designing the layer."
    });
    store.checkpointSession({
      agent_id: "bede",
      session_id: session.id,
      summary: "Wired the foundation.",
      next_steps: ["Add MCP tools"]
    });

    const response = await callTool(
      store,
      "continue_session",
      {
        session_id: session.id,
        target_harness: "codex",
        target_source_ref: "codex:r1:cwd:/dev",
        target_cwd: "/dev"
      },
      { role: "agent", agentId: "codex" }
    );

    const text = response.result.content[0].text;
    assert.match(text, /Handover via MCP/);
    assert.match(text, /Wired the foundation/);

    const reloaded = store.getSession(session.id);
    assert.equal(reloaded.current_harness, "codex", "default attach=true should switch current harness");
    assert.equal(reloaded.current_agent_id, "codex");
  });
});

test("MCP continue_session honours format=markdown", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Markdown via MCP",
      harness: "hermes",
      start_summary: "Starting."
    });
    store.checkpointSession({
      agent_id: "bede",
      session_id: session.id,
      summary: "Mid.",
      decisions: ["Decision X"]
    });

    const response = await callTool(
      store,
      "continue_session",
      { session_id: session.id, target_harness: "claude-code", format: "markdown", attach: false },
      { role: "agent", agentId: "bede" }
    );

    const text = response.result.content[0].text;
    assert.match(text, /# Librarian Session Handover/);
    assert.match(text, /## Decisions/);
    assert.match(text, /Decision X/);
  });
});

test("MCP continue_session refuses to attach to another agent's private session", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({
      agent_id: "codex",
      title: "Codex private",
      harness: "codex",
      visibility: "agent_private"
    });

    const response = await callTool(
      store,
      "continue_session",
      { session_id: session.id, target_harness: "hermes" },
      { role: "agent", agentId: "bede" }
    );

    assert.match(response.result.content[0].text, /not found|no session/i);
    const reloaded = store.getSession(session.id);
    assert.equal(reloaded.current_harness, "codex", "private session must remain on its original harness");
  });
});

test("MCP tools/list exposes session hide tools", async () => {
  await withStore(async (store) => {
    const list = await handleMcpPayload(store, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const names = list.result.tools.map((tool) => tool.name);
    for (const expected of ["archive_session", "restore_session", "delete_session"]) {
      assert.ok(names.includes(expected), `expected ${expected} in tool list`);
    }
  });
});

test("MCP archive_session hides a session from default list_sessions", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({ agent_id: "bede", title: "Archive me", harness: "hermes" });

    const response = await callTool(
      store,
      "archive_session",
      { session_id: session.id, reason: "throwaway spike" },
      { role: "agent", agentId: "bede" }
    );
    assert.match(response.result.content[0].text, /archived/i);

    const list = await callTool(store, "list_sessions", {}, { role: "agent", agentId: "bede" });
    assert.doesNotMatch(list.result.content[0].text, /Archive me/);
  });
});

test("MCP delete_session lets the owner delete their own session", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({ agent_id: "bede", title: "Owner deletes own", harness: "hermes" });

    const response = await callTool(
      store,
      "delete_session",
      { session_id: session.id },
      { role: "agent", agentId: "bede" }
    );
    assert.match(response.result.content[0].text, /deleted/i);
    assert.equal(store.getSession(session.id).status, "deleted");
  });
});

test("MCP delete_session refuses a non-owner agent on a visible common session", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Bede's common session",
      harness: "hermes",
      visibility: "common"
    });

    const response = await callTool(
      store,
      "delete_session",
      { session_id: session.id },
      { role: "agent", agentId: "codex" }
    );

    assert.ok(response.error, "non-owner delete should produce a JSON-RPC error");
    assert.match(response.error.message, /owner|permission|admin/i);
    assert.equal(store.getSession(session.id).status, "active");
  });
});

test("MCP delete_session on another agent's private session returns 'not found' (does not reveal existence)", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({
      agent_id: "codex",
      title: "Codex private",
      harness: "codex",
      visibility: "agent_private"
    });

    const response = await callTool(
      store,
      "delete_session",
      { session_id: session.id },
      { role: "agent", agentId: "bede" }
    );

    assert.equal(response.error, undefined, "must not leak ownership error for invisible sessions");
    assert.match(response.result.content[0].text, /not found|no session/i);
    assert.equal(store.getSession(session.id).status, "active");
  });
});

test("MCP delete_session as admin can delete sessions owned by other agents", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({ agent_id: "bede", title: "Bede's", harness: "hermes" });

    const response = await callTool(
      store,
      "delete_session",
      { session_id: session.id, reason: "admin cleanup" },
      { role: "admin" }
    );
    assert.match(response.result.content[0].text, /deleted/i);
    assert.equal(store.getSession(session.id).status, "deleted");
  });
});

test("MCP restore_session by owner returns the session to its prior status", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({ agent_id: "bede", title: "Restorable", harness: "hermes" });
    store.pauseSession({ agent_id: "bede", session_id: session.id, summary: "Pause." });
    store.archiveSession({ agent_id: "bede", session_id: session.id, reason: "tidy" });

    const response = await callTool(
      store,
      "restore_session",
      { session_id: session.id },
      { role: "agent", agentId: "bede" }
    );

    assert.match(response.result.content[0].text, /restore|paused|active/i);
    assert.equal(store.getSession(session.id).status, "paused");
  });
});

test("MCP restore_session refuses non-owner non-admin callers", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({ agent_id: "bede", title: "Bede's", harness: "hermes" });
    store.archiveSession({ agent_id: "bede", session_id: session.id, reason: "tidy" });

    const response = await callTool(
      store,
      "restore_session",
      { session_id: session.id },
      { role: "agent", agentId: "codex" }
    );

    assert.ok(response.error);
    assert.match(response.error.message, /owner|permission|admin/i);
    assert.equal(store.getSession(session.id).status, "archived");
  });
});
