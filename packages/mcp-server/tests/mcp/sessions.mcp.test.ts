// MCP session-tool behaviour tests.
//
// Migrated from packages/mcp-server/tests/sessions.mcp.test.js as part
// of T4.2. Behaviour coverage is identical to the pre-migration suite —
// these tests exercise the session tool handlers, visibility gates,
// continue/attach flows, and promote_session_fact through
// `handleMcpPayload`.

import type { LibrarianStore } from "@librarian/core";
import { handleMcpPayload } from "@librarian/mcp-server";
import { describe, expect, it } from "vitest";
import { withStore } from "../../../../test/helpers.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyResponse = any;

function callTool(
  store: LibrarianStore,
  name: string,
  args: Record<string, unknown>,
  context: { role?: "admin" | "agent"; agentId?: string } = {},
): Promise<AnyResponse> {
  return handleMcpPayload(
    store,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    context,
  ) as Promise<AnyResponse>;
}

describe("MCP session tools", () => {
  it("MCP tools/list exposes the session read-tool surface", async () => {
    await withStore(async (store) => {
      const list = await handleMcpPayload(store, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      const names = list.result.tools.map((tool) => tool.name);
      for (const expected of [
        "start_session",
        "get_session",
        "list_sessions",
        "list_session_events",
        "search_sessions",
      ]) {
        expect(names.includes(expected)).toBeTruthy();
      }
    });
  });

  it("MCP start_session creates a session attributed to the authenticated agent", async () => {
    await withStore(async (store) => {
      const response = await callTool(
        store,
        "start_session",
        {
          title: "MCP foundational test",
          harness: "hermes",
          project_key: "the-librarian",
          start_summary: "Investigating MCP tool surface.",
        },
        { role: "agent", agentId: "bede" },
      );

      const text = response.result.content[0].text;
      expect(text).toMatch(/ses_/);
      expect(text).toMatch(/MCP foundational test/);

      const sessions = store.listSessions({ agent_id: "bede" }).sessions;
      expect(sessions.length).toBe(1);
      expect(sessions[0].created_by_agent_id).toBe("bede");
      expect(sessions[0].title).toBe("MCP foundational test");
    });
  });

  it("MCP start_session refuses to honour a caller-supplied agent_id (no impersonation)", async () => {
    await withStore(async (store) => {
      await callTool(
        store,
        "start_session",
        {
          agent_id: "imposter",
          title: "Impersonation attempt",
          harness: "hermes",
        },
        { role: "agent", agentId: "bede" },
      );

      const sessions = store.listSessions({ agent_id: "bede" }).sessions;
      expect(sessions.length).toBe(1);
      expect(sessions[0].created_by_agent_id).toBe("bede");
      expect(sessions[0].created_by_agent_id).not.toBe("imposter");
    });
  });

  it("MCP start_session output is clean prose and does not leak internal event ids", async () => {
    await withStore(async (store) => {
      const response = await callTool(
        store,
        "start_session",
        {
          title: "Cleanliness check",
          harness: "hermes",
        },
        { role: "agent", agentId: "bede" },
      );

      const text = response.result.content[0].text;
      expect(text).not.toMatch(/sevt_/);
      expect(text).not.toMatch(/evt_/);
    });
  });

  it("MCP list_sessions returns numbered selectable sessions and tells the agent to use session_id", async () => {
    await withStore(async (store) => {
      store.startSession({ agent_id: "bede", title: "First", harness: "hermes" });
      store.startSession({ agent_id: "bede", title: "Second", harness: "hermes" });

      const response = await callTool(
        store,
        "list_sessions",
        {},
        { role: "agent", agentId: "bede" },
      );
      const text = response.result.content[0].text;
      expect(text).toMatch(/1\. /);
      expect(text).toMatch(/2\. /);
      expect(text).toMatch(/First/);
      expect(text).toMatch(/Second/);
      expect(text).toMatch(/session_id/i);
    });
  });

  it("MCP list_sessions does not include another agent's private sessions", async () => {
    await withStore(async (store) => {
      store.startSession({ agent_id: "bede", title: "Bede shared", harness: "hermes" });
      store.startSession({
        agent_id: "codex",
        title: "Codex private",
        harness: "codex",
        visibility: "agent_private",
      });

      const response = await callTool(
        store,
        "list_sessions",
        {},
        { role: "agent", agentId: "bede" },
      );
      const text = response.result.content[0].text;
      expect(text).toMatch(/Bede shared/);
      expect(text).not.toMatch(/Codex private/);
    });
  });

  it("MCP get_session hides agent_private sessions from non-owner callers", async () => {
    await withStore(async (store) => {
      const { session } = store.startSession({
        agent_id: "codex",
        title: "Codex private session",
        harness: "codex",
        visibility: "agent_private",
      });

      const asBede = await callTool(
        store,
        "get_session",
        { session_id: session.id },
        { role: "agent", agentId: "bede" },
      );
      const bedeText = asBede.result.content[0].text;
      expect(bedeText).not.toMatch(/Codex private session/);
      expect(bedeText).toMatch(/not found|no session/i);

      const asCodex = await callTool(
        store,
        "get_session",
        { session_id: session.id },
        { role: "agent", agentId: "codex" },
      );
      expect(asCodex.result.content[0].text).toMatch(/Codex private session/);
    });
  });

  it("MCP get_session admin can see another agent's private session", async () => {
    await withStore(async (store) => {
      const { session } = store.startSession({
        agent_id: "codex",
        title: "Codex private",
        harness: "codex",
        visibility: "agent_private",
      });
      const response = await callTool(
        store,
        "get_session",
        { session_id: session.id },
        { role: "admin" },
      );
      expect(response.result.content[0].text).toMatch(/Codex private/);
    });
  });

  it("MCP list_session_events hides events from non-owners of agent_private sessions", async () => {
    await withStore(async (store) => {
      const { session } = store.startSession({
        agent_id: "codex",
        title: "Codex priv",
        harness: "codex",
        visibility: "agent_private",
      });
      store.recordSessionEvent({
        agent_id: "codex",
        session_id: session.id,
        type: "decision",
        summary: "Codex secret decision.",
      });

      const asBede = await callTool(
        store,
        "list_session_events",
        { session_id: session.id },
        { role: "agent", agentId: "bede" },
      );
      const text = asBede.result.content[0].text;
      expect(text).not.toMatch(/Codex secret decision/);
      expect(text).toMatch(/not found|no session|no events/i);
    });
  });

  it("MCP search_sessions does not leak private content from other agents", async () => {
    await withStore(async (store) => {
      store.startSession({
        agent_id: "codex",
        title: "Codex BM25 work",
        harness: "codex",
        visibility: "agent_private",
        start_summary: "Investigate BM25 recall in private.",
      });

      const asBede = await callTool(
        store,
        "search_sessions",
        { query: "BM25" },
        { role: "agent", agentId: "bede" },
      );
      const text = asBede.result.content[0].text;
      expect(text).not.toMatch(/Codex BM25/);
    });
  });

  it("MCP tools/list exposes session mutation tools", async () => {
    await withStore(async (store) => {
      const list = await handleMcpPayload(store, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      const names = list.result.tools.map((tool) => tool.name);
      for (const expected of [
        "record_session_event",
        "checkpoint_session",
        "pause_session",
        "end_session",
        "attach_session",
        "continue_session",
      ]) {
        expect(names.includes(expected)).toBeTruthy();
      }
    });
  });

  it("MCP record_session_event appends a typed event to a visible session", async () => {
    await withStore(async (store) => {
      const { session } = store.startSession({
        agent_id: "bede",
        title: "Recordable",
        harness: "hermes",
      });

      const response = await callTool(
        store,
        "record_session_event",
        { session_id: session.id, type: "decision", summary: "Default attach=true." },
        { role: "agent", agentId: "bede" },
      );

      expect(response.result.content[0].text).toMatch(/record|decision/i);
      const events = store.listSessionEvents({ session_id: session.id });
      expect(
        events.events.some(
          (event: { type: string; summary: string }) =>
            event.type === "decision" && event.summary === "Default attach=true.",
        ),
      ).toBeTruthy();
    });
  });

  it("MCP record_session_event refuses to mutate another agent's private session", async () => {
    await withStore(async (store) => {
      const { session } = store.startSession({
        agent_id: "codex",
        title: "Codex private",
        harness: "codex",
        visibility: "agent_private",
      });

      const response = await callTool(
        store,
        "record_session_event",
        { session_id: session.id, type: "note", summary: "I shouldn't be here." },
        { role: "agent", agentId: "bede" },
      );

      expect(response.result.content[0].text).toMatch(/not found|no session/i);
      const events = store.listSessionEvents({ session_id: session.id });
      expect(
        events.events.some(
          (event: { summary: string }) => event.summary === "I shouldn't be here.",
        ),
      ).toBe(false);
    });
  });

  it("MCP pause_session marks the session paused", async () => {
    await withStore(async (store) => {
      const { session } = store.startSession({
        agent_id: "bede",
        title: "Pausable",
        harness: "hermes",
      });

      const response = await callTool(
        store,
        "pause_session",
        { session_id: session.id, summary: "Stopping for the day." },
        { role: "agent", agentId: "bede" },
      );

      expect(response.result.content[0].text).toMatch(/paused/i);
      const reloaded = store.getSession(session.id);
      expect(reloaded.status).toBe("paused");
      expect(reloaded.rolling_summary).toBe("Stopping for the day.");
    });
  });

  it("MCP end_session writes end_summary and marks the session ended", async () => {
    await withStore(async (store) => {
      const { session } = store.startSession({
        agent_id: "bede",
        title: "Endable",
        harness: "hermes",
      });

      const response = await callTool(
        store,
        "end_session",
        { session_id: session.id, summary: "All done." },
        { role: "agent", agentId: "bede" },
      );

      expect(response.result.content[0].text).toMatch(/ended/i);
      const reloaded = store.getSession(session.id);
      expect(reloaded.status).toBe("ended");
      expect(reloaded.end_summary).toBe("All done.");
    });
  });

  it("MCP attach_session updates the current harness and source_ref", async () => {
    await withStore(async (store) => {
      const { session } = store.startSession({
        agent_id: "bede",
        title: "Attachable",
        harness: "hermes",
        source_ref: "discord:1:2",
      });

      await callTool(
        store,
        "attach_session",
        {
          session_id: session.id,
          harness: "codex",
          source_ref: "codex:r1:cwd:/dev",
          cwd: "/dev",
        },
        { role: "agent", agentId: "codex" },
      );

      const reloaded = store.getSession(session.id);
      expect(reloaded.current_harness).toBe("codex");
      expect(reloaded.current_agent_id).toBe("codex");
      expect(reloaded.source_ref).toBe("codex:r1:cwd:/dev");
      expect(reloaded.created_in_harness).toBe("hermes");
    });
  });

  it("MCP continue_session returns a handover package and (default) attaches", async () => {
    await withStore(async (store) => {
      const { session } = store.startSession({
        agent_id: "bede",
        title: "Handover via MCP",
        harness: "hermes",
        project_key: "the-librarian",
        start_summary: "Designing the layer.",
      });
      store.checkpointSession({
        agent_id: "bede",
        session_id: session.id,
        summary: "Wired the foundation.",
        next_steps: ["Add MCP tools"],
      });

      const response = await callTool(
        store,
        "continue_session",
        {
          session_id: session.id,
          target_harness: "codex",
          target_source_ref: "codex:r1:cwd:/dev",
          target_cwd: "/dev",
        },
        { role: "agent", agentId: "codex" },
      );

      const text = response.result.content[0].text;
      expect(text).toMatch(/Handover via MCP/);
      expect(text).toMatch(/Wired the foundation/);

      const reloaded = store.getSession(session.id);
      expect(reloaded.current_harness).toBe("codex");
      expect(reloaded.current_agent_id).toBe("codex");
    });
  });

  it("MCP continue_session honours format=markdown", async () => {
    await withStore(async (store) => {
      const { session } = store.startSession({
        agent_id: "bede",
        title: "Markdown via MCP",
        harness: "hermes",
        start_summary: "Starting.",
      });
      store.checkpointSession({
        agent_id: "bede",
        session_id: session.id,
        summary: "Mid.",
        decisions: ["Decision X"],
      });

      const response = await callTool(
        store,
        "continue_session",
        {
          session_id: session.id,
          target_harness: "claude-code",
          format: "markdown",
          attach: false,
        },
        { role: "agent", agentId: "bede" },
      );

      const text = response.result.content[0].text;
      expect(text).toMatch(/# Librarian Session Handover/);
      expect(text).toMatch(/## Decisions/);
      expect(text).toMatch(/Decision X/);
    });
  });

  it("MCP continue_session refuses to attach to another agent's private session", async () => {
    await withStore(async (store) => {
      const { session } = store.startSession({
        agent_id: "codex",
        title: "Codex private",
        harness: "codex",
        visibility: "agent_private",
      });

      const response = await callTool(
        store,
        "continue_session",
        { session_id: session.id, target_harness: "hermes" },
        { role: "agent", agentId: "bede" },
      );

      expect(response.result.content[0].text).toMatch(/not found|no session/i);
      const reloaded = store.getSession(session.id);
      expect(reloaded.current_harness).toBe("codex");
    });
  });

  it("MCP tools/list exposes session hide tools", async () => {
    await withStore(async (store) => {
      const list = await handleMcpPayload(store, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      const names = list.result.tools.map((tool) => tool.name);
      for (const expected of ["archive_session", "restore_session", "delete_session"]) {
        expect(names.includes(expected)).toBeTruthy();
      }
    });
  });

  it("MCP archive_session hides a session from default list_sessions", async () => {
    await withStore(async (store) => {
      const { session } = store.startSession({
        agent_id: "bede",
        title: "Archive me",
        harness: "hermes",
      });

      const response = await callTool(
        store,
        "archive_session",
        { session_id: session.id, reason: "throwaway spike" },
        { role: "agent", agentId: "bede" },
      );
      expect(response.result.content[0].text).toMatch(/archived/i);

      const list = await callTool(store, "list_sessions", {}, { role: "agent", agentId: "bede" });
      expect(list.result.content[0].text).not.toMatch(/Archive me/);
    });
  });

  it("MCP delete_session lets the owner delete their own session", async () => {
    await withStore(async (store) => {
      const { session } = store.startSession({
        agent_id: "bede",
        title: "Owner deletes own",
        harness: "hermes",
      });

      const response = await callTool(
        store,
        "delete_session",
        { session_id: session.id },
        { role: "agent", agentId: "bede" },
      );
      expect(response.result.content[0].text).toMatch(/deleted/i);
      expect(store.getSession(session.id).status).toBe("deleted");
    });
  });

  it("MCP delete_session refuses a non-owner agent on a visible common session", async () => {
    await withStore(async (store) => {
      const { session } = store.startSession({
        agent_id: "bede",
        title: "Bede's common session",
        harness: "hermes",
        visibility: "common",
      });

      const response = await callTool(
        store,
        "delete_session",
        { session_id: session.id },
        { role: "agent", agentId: "codex" },
      );

      expect(response.error).toBeTruthy();
      expect(response.error.message).toMatch(/owner|permission|admin/i);
      expect(store.getSession(session.id).status).toBe("active");
    });
  });

  it("MCP delete_session on another agent's private session returns 'not found' (does not reveal existence)", async () => {
    await withStore(async (store) => {
      const { session } = store.startSession({
        agent_id: "codex",
        title: "Codex private",
        harness: "codex",
        visibility: "agent_private",
      });

      const response = await callTool(
        store,
        "delete_session",
        { session_id: session.id },
        { role: "agent", agentId: "bede" },
      );

      expect(response.error).toBe(undefined);
      expect(response.result.content[0].text).toMatch(/not found|no session/i);
      expect(store.getSession(session.id).status).toBe("active");
    });
  });

  it("MCP delete_session as admin can delete sessions owned by other agents", async () => {
    await withStore(async (store) => {
      const { session } = store.startSession({
        agent_id: "bede",
        title: "Bede's",
        harness: "hermes",
      });

      const response = await callTool(
        store,
        "delete_session",
        { session_id: session.id, reason: "admin cleanup" },
        { role: "admin" },
      );
      expect(response.result.content[0].text).toMatch(/deleted/i);
      expect(store.getSession(session.id).status).toBe("deleted");
    });
  });

  it("MCP restore_session by owner returns the session to its prior status", async () => {
    await withStore(async (store) => {
      const { session } = store.startSession({
        agent_id: "bede",
        title: "Restorable",
        harness: "hermes",
      });
      store.pauseSession({ agent_id: "bede", session_id: session.id, summary: "Pause." });
      store.archiveSession({ agent_id: "bede", session_id: session.id, reason: "tidy" });

      const response = await callTool(
        store,
        "restore_session",
        { session_id: session.id },
        { role: "agent", agentId: "bede" },
      );

      expect(response.result.content[0].text).toMatch(/restore|paused|active/i);
      expect(store.getSession(session.id).status).toBe("paused");
    });
  });

  it("MCP restore_session refuses non-owner non-admin callers", async () => {
    await withStore(async (store) => {
      const { session } = store.startSession({
        agent_id: "bede",
        title: "Bede's",
        harness: "hermes",
      });
      store.archiveSession({ agent_id: "bede", session_id: session.id, reason: "tidy" });

      const response = await callTool(
        store,
        "restore_session",
        { session_id: session.id },
        { role: "agent", agentId: "codex" },
      );

      expect(response.error).toBeTruthy();
      expect(response.error.message).toMatch(/owner|permission|admin/i);
      expect(store.getSession(session.id).status).toBe("archived");
    });
  });

  it("MCP tools/list exposes promote_session_fact", async () => {
    await withStore(async (store) => {
      const list = await handleMcpPayload(store, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      const names = list.result.tools.map((tool) => tool.name);
      expect(names.includes("promote_session_fact")).toBeTruthy();
    });
  });

  it("MCP promote_session_fact creates an active durable memory for non-protected categories", async () => {
    await withStore(async (store) => {
      const { session } = store.startSession({
        agent_id: "bede",
        title: "Promote test",
        harness: "hermes",
      });

      const response = await callTool(
        store,
        "promote_session_fact",
        {
          session_id: session.id,
          memory: {
            title: "Use lib: prefix for session commands",
            body: "Avoids harness slash command collisions.",
            category: "tools",
            visibility: "common",
            scope: "tool",
          },
        },
        { role: "agent", agentId: "bede" },
      );

      const text = response.result.content[0].text;
      expect(text).toMatch(/promoted|memory|active/i);
      const active = store
        .listAll({ status: "active" })
        .filter((memory) => memory.title === "Use lib: prefix for session commands");
      expect(active.length).toBe(1);
    });
  });

  it("MCP promote_session_fact routes protected categories through the proposal flow even for non-admin agents", async () => {
    await withStore(async (store) => {
      const { session } = store.startSession({
        agent_id: "bede",
        title: "Protected promote",
        harness: "hermes",
      });

      const response = await callTool(
        store,
        "promote_session_fact",
        {
          session_id: session.id,
          memory: {
            title: "User prefers terse responses",
            body: "Jim asked for terse output across sessions.",
            category: "identity",
            visibility: "common",
            scope: "global",
          },
        },
        { role: "agent", agentId: "bede" },
      );

      expect(response.result.content[0].text).toMatch(/proposal|proposed/i);
      const proposed = store
        .listAll({ status: "proposed" })
        .filter((memory) => memory.title === "User prefers terse responses");
      expect(proposed.length).toBe(1);
    });
  });

  it("MCP promote_session_fact refuses to promote from another agent's private session", async () => {
    await withStore(async (store) => {
      const { session } = store.startSession({
        agent_id: "codex",
        title: "Codex private",
        harness: "codex",
        visibility: "agent_private",
      });

      const response = await callTool(
        store,
        "promote_session_fact",
        {
          session_id: session.id,
          memory: {
            title: "Stolen fact",
            body: "Should not be created.",
            category: "tools",
            visibility: "common",
            scope: "tool",
          },
        },
        { role: "agent", agentId: "bede" },
      );

      expect(response.result.content[0].text).toMatch(/not found|no session/i);
      const stolen = store
        .listAll({ status: "active" })
        .filter((memory) => memory.title === "Stolen fact");
      expect(stolen.length).toBe(0);
    });
  });
});
