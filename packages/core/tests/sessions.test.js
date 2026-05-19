import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { withStore } from "../../../test/helpers.js";

test("startSession creates an active common session with the supplied fields", async () => {
  await withStore((store) => {
    const result = store.startSession({
      agent_id: "bede",
      title: "Cross-harness recall design",
      project_key: "the-librarian",
      visibility: "common",
      harness: "hermes",
      source_ref: "discord:channel:1:thread:2",
      cwd: "/home/jim/the-librarian",
      capture_mode: "summary",
      start_summary: "Sketch the session layer.",
      tags: ["sessions", "librarian"],
    });

    const session = result.session;
    assert.ok(session.id.startsWith("ses_"), `unexpected id ${session.id}`);
    assert.equal(session.title, "Cross-harness recall design");
    assert.equal(session.project_key, "the-librarian");
    assert.equal(session.status, "active");
    assert.equal(session.prior_status, null);
    assert.equal(session.visibility, "common");
    assert.equal(session.created_by_agent_id, "bede");
    assert.equal(session.current_agent_id, "bede");
    assert.equal(session.created_in_harness, "hermes");
    assert.equal(session.current_harness, "hermes");
    assert.equal(session.source_ref, "discord:channel:1:thread:2");
    assert.equal(session.cwd, "/home/jim/the-librarian");
    assert.equal(session.capture_mode, "summary");
    assert.equal(session.start_summary, "Sketch the session layer.");
    assert.equal(session.rolling_summary, null);
    assert.equal(session.end_summary, null);
    assert.deepEqual(session.next_steps, []);
    assert.deepEqual(session.tags, ["sessions", "librarian"]);
    assert.ok(session.started_at);
    assert.equal(session.updated_at, session.started_at);
    assert.equal(session.last_activity_at, session.started_at);
    assert.equal(session.paused_at, null);
    assert.equal(session.ended_at, null);
    assert.equal(session.archived_at, null);
    assert.equal(session.deleted_at, null);
    assert.deepEqual(session.metadata, {});
  });
});

test("startSession generates a placeholder title when one is not supplied", async () => {
  await withStore((store) => {
    const fromProject = store.startSession({
      agent_id: "bede",
      project_key: "the-librarian",
      harness: "codex",
    });
    assert.match(fromProject.session.title, /^the-librarian session @ /);

    const fromHarness = store.startSession({
      agent_id: "bede",
      harness: "codex",
    });
    assert.match(fromHarness.session.title, /^codex session @ /);
  });
});

test("startSession defaults visibility to common and capture_mode to summary", async () => {
  await withStore((store) => {
    const result = store.startSession({ agent_id: "bede", title: "Defaults", harness: "hermes" });
    assert.equal(result.session.visibility, "common");
    assert.equal(result.session.capture_mode, "summary");
  });
});

test("startSession accepts an explicit agent_private visibility", async () => {
  await withStore((store) => {
    const result = store.startSession({
      agent_id: "bede",
      title: "Private spike",
      harness: "hermes",
      visibility: "agent_private",
    });
    assert.equal(result.session.visibility, "agent_private");
  });
});

test("startSession appends a session.started event to sessions.jsonl and inserts a row in the projection", async () => {
  await withStore((store, dataDir) => {
    const sessionsPath = path.join(dataDir, "sessions.jsonl");
    assert.ok(fs.existsSync(sessionsPath), "sessions.jsonl should be created on startup");

    const result = store.startSession({
      agent_id: "bede",
      title: "Event projection",
      harness: "hermes",
    });

    const lines = fs.readFileSync(sessionsPath, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]);
    assert.equal(event.event_type, "session.started");
    assert.equal(event.session_id, result.session.id);
    assert.equal(event.agent_id, "bede");
    assert.ok(event.created_at);
    assert.ok(event.payload?.session?.id, "event payload should embed the session snapshot");

    const fetched = store.getSession(result.session.id);
    assert.equal(fetched.id, result.session.id);
    assert.equal(fetched.title, "Event projection");
  });
});

test("getSession returns null for an unknown id and does not throw", async () => {
  await withStore((store) => {
    assert.equal(store.getSession("ses_does_not_exist"), null);
  });
});

test("multiple active sessions can coexist", async () => {
  await withStore((store) => {
    const first = store.startSession({ agent_id: "bede", title: "First", harness: "hermes" });
    const second = store.startSession({ agent_id: "codex", title: "Second", harness: "codex" });
    assert.notEqual(first.session.id, second.session.id);
    assert.equal(store.getSession(first.session.id).status, "active");
    assert.equal(store.getSession(second.session.id).status, "active");
  });
});

test("memory writes do not touch the session projection (and vice versa)", async () => {
  await withStore((store, dataDir) => {
    store.createMemory({
      agent_id: "bede",
      title: "Memory still works",
      body: "Adding sessions must not regress memory writes.",
      category: "tools",
      visibility: "common",
      scope: "tool",
    });
    store.startSession({ agent_id: "bede", title: "Session still works", harness: "hermes" });

    const memEvents = fs
      .readFileSync(path.join(dataDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const sessEvents = fs
      .readFileSync(path.join(dataDir, "sessions.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.equal(memEvents.length, 1, "memory event ledger should only have one entry");
    assert.equal(sessEvents.length, 1, "session event ledger should only have one entry");
  });
});

test("listSessions returns multiple selectable sessions and never auto-selects", async () => {
  await withStore((store) => {
    const first = store.startSession({ agent_id: "bede", title: "First", harness: "hermes" });
    const second = store.startSession({ agent_id: "bede", title: "Second", harness: "hermes" });

    const result = store.listSessions({ agent_id: "bede" });

    assert.equal(result.sessions.length, 2);
    const ids = result.sessions.map((s) => s.id);
    assert.ok(ids.includes(first.session.id));
    assert.ok(ids.includes(second.session.id));
    assert.equal(result.selected, undefined);
    assert.equal(result.current, undefined);
  });
});

test("listSessions ranks sessions matching the caller project_key first", async () => {
  await withStore((store) => {
    const other = store.startSession({
      agent_id: "bede",
      title: "Other project",
      harness: "hermes",
      project_key: "other-repo",
    });
    const target = store.startSession({
      agent_id: "bede",
      title: "Target project",
      harness: "hermes",
      project_key: "the-librarian",
    });

    const result = store.listSessions({ agent_id: "bede", project_key: "the-librarian" });

    assert.equal(result.sessions[0].id, target.session.id);
    assert.equal(result.sessions[1].id, other.session.id);
  });
});

test("listSessions ranks source-matching sessions ahead of non-matching when project matches both", async () => {
  await withStore((store) => {
    const sameProjOtherSrc = store.startSession({
      agent_id: "bede",
      title: "Same proj, other cwd",
      harness: "hermes",
      project_key: "the-librarian",
      cwd: "/somewhere/else",
    });
    const sameProjSameSrc = store.startSession({
      agent_id: "bede",
      title: "Same proj, same cwd",
      harness: "hermes",
      project_key: "the-librarian",
      cwd: "/home/jim/the-librarian",
    });

    const result = store.listSessions({
      agent_id: "bede",
      project_key: "the-librarian",
      cwd: "/home/jim/the-librarian",
    });

    assert.equal(result.sessions[0].id, sameProjSameSrc.session.id);
    assert.equal(result.sessions[1].id, sameProjOtherSrc.session.id);
  });
});

test("listSessions matches by source_ref as well as cwd when ranking source", async () => {
  await withStore((store) => {
    const otherSrc = store.startSession({
      agent_id: "bede",
      title: "Different thread",
      harness: "hermes",
      source_ref: "discord:channel:1:thread:2",
    });
    const matchingSrc = store.startSession({
      agent_id: "bede",
      title: "Matching thread",
      harness: "hermes",
      source_ref: "discord:channel:9:thread:42",
    });

    const result = store.listSessions({
      agent_id: "bede",
      source_ref: "discord:channel:9:thread:42",
    });

    assert.equal(result.sessions[0].id, matchingSrc.session.id);
    assert.equal(result.sessions[1].id, otherSrc.session.id);
  });
});

test("listSessions hides agent_private sessions from other agents", async () => {
  await withStore((store) => {
    const shared = store.startSession({
      agent_id: "bede",
      title: "Shared",
      harness: "hermes",
      visibility: "common",
    });
    const bedePrivate = store.startSession({
      agent_id: "bede",
      title: "Bede private",
      harness: "hermes",
      visibility: "agent_private",
    });
    const codexPrivate = store.startSession({
      agent_id: "codex",
      title: "Codex private",
      harness: "codex",
      visibility: "agent_private",
    });

    const asBede = store.listSessions({ agent_id: "bede" }).sessions.map((s) => s.id);
    assert.ok(asBede.includes(shared.session.id));
    assert.ok(asBede.includes(bedePrivate.session.id));
    assert.ok(!asBede.includes(codexPrivate.session.id));

    const asCodex = store.listSessions({ agent_id: "codex" }).sessions.map((s) => s.id);
    assert.ok(asCodex.includes(shared.session.id));
    assert.ok(!asCodex.includes(bedePrivate.session.id));
    assert.ok(asCodex.includes(codexPrivate.session.id));
  });
});

test("listSessions admin override sees agent_private sessions from any agent", async () => {
  await withStore((store) => {
    const codexPrivate = store.startSession({
      agent_id: "codex",
      title: "Codex private",
      harness: "codex",
      visibility: "agent_private",
    });

    const asAdmin = store.listSessions({ agent_id: "bede", admin: true }).sessions.map((s) => s.id);
    assert.ok(asAdmin.includes(codexPrivate.session.id));
  });
});

test("listSessions honors limit", async () => {
  await withStore((store) => {
    for (let i = 0; i < 5; i += 1) {
      store.startSession({ agent_id: "bede", title: `Session ${i}`, harness: "hermes" });
    }
    const result = store.listSessions({ agent_id: "bede", limit: 3 });
    assert.equal(result.sessions.length, 3);
    assert.equal(result.total, 5);
    assert.equal(result.limit, 3);
  });
});

test("listSessions returns the most recently active session first when all ranking keys tie", async () => {
  await withStore(async (store) => {
    const first = store.startSession({ agent_id: "bede", title: "First", harness: "hermes" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = store.startSession({ agent_id: "bede", title: "Second", harness: "hermes" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const third = store.startSession({ agent_id: "bede", title: "Third", harness: "hermes" });

    const result = store.listSessions({ agent_id: "bede" });
    assert.deepEqual(
      result.sessions.map((s) => s.id),
      [third.session.id, second.session.id, first.session.id],
    );
  });
});

test("listSessions filters by harness when supplied", async () => {
  await withStore((store) => {
    const onHermes = store.startSession({ agent_id: "bede", title: "Hermes", harness: "hermes" });
    store.startSession({ agent_id: "bede", title: "Codex", harness: "codex" });

    const result = store.listSessions({ agent_id: "bede", harness: "hermes" });
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].id, onHermes.session.id);
  });
});

test("recordSessionEvent appends a typed evidence event and bumps last_activity_at", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Recording",
      harness: "hermes",
    });
    const initialActivity = session.last_activity_at;

    await new Promise((resolve) => setTimeout(resolve, 5));

    const event = store.recordSessionEvent({
      agent_id: "bede",
      session_id: session.id,
      harness: "hermes",
      type: "decision",
      summary: "Use list-and-select rather than latest-inference.",
      payload: { confidence: "confirmed" },
    });

    assert.equal(event.event_type, "session.event_recorded");
    assert.equal(event.session_id, session.id);
    assert.equal(event.payload.type, "decision");
    assert.equal(event.payload.summary, "Use list-and-select rather than latest-inference.");
    assert.equal(event.payload.confidence, "confirmed");

    const reloaded = store.getSession(session.id);
    assert.ok(reloaded.last_activity_at > initialActivity, "last_activity_at should advance");
    assert.ok(reloaded.updated_at > initialActivity, "updated_at should advance");
    assert.equal(reloaded.status, "active");
  });
});

test("recordSessionEvent rejects unknown payload types", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Reject",
      harness: "hermes",
    });
    assert.throws(
      () =>
        store.recordSessionEvent({
          agent_id: "bede",
          session_id: session.id,
          type: "garbage",
          summary: "x",
        }),
      /payload type/i,
    );
  });
});

test("recordSessionEvent throws for unknown session_id", async () => {
  await withStore((store) => {
    assert.throws(
      () =>
        store.recordSessionEvent({
          agent_id: "bede",
          session_id: "ses_nope",
          type: "note",
          summary: "x",
        }),
      /session/i,
    );
  });
});

test("listSessionEvents returns events with pagination and type filter", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Listing",
      harness: "hermes",
    });

    store.recordSessionEvent({
      agent_id: "bede",
      session_id: session.id,
      type: "decision",
      summary: "d1",
    });
    store.recordSessionEvent({
      agent_id: "bede",
      session_id: session.id,
      type: "command",
      summary: "c1",
    });
    store.recordSessionEvent({
      agent_id: "bede",
      session_id: session.id,
      type: "decision",
      summary: "d2",
    });
    store.recordSessionEvent({
      agent_id: "bede",
      session_id: session.id,
      type: "note",
      summary: "n1",
    });

    const all = store.listSessionEvents({ session_id: session.id });
    assert.equal(all.total, 5, "start event + 4 record events");
    assert.equal(all.events.length, 5);

    const decisions = store.listSessionEvents({ session_id: session.id, type: "decision" });
    assert.equal(decisions.total, 2);
    assert.ok(decisions.events.every((event) => event.type === "decision"));

    const paginated = store.listSessionEvents({ session_id: session.id, limit: 2, offset: 1 });
    assert.equal(paginated.events.length, 2);
    assert.equal(paginated.limit, 2);
    assert.equal(paginated.offset, 1);
    assert.equal(paginated.total, 5);
  });
});

test("listSessionEvents returns events in chronological order (oldest first)", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({ agent_id: "bede", title: "Order", harness: "hermes" });
    await new Promise((resolve) => setTimeout(resolve, 2));
    store.recordSessionEvent({
      agent_id: "bede",
      session_id: session.id,
      type: "note",
      summary: "first",
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    store.recordSessionEvent({
      agent_id: "bede",
      session_id: session.id,
      type: "note",
      summary: "second",
    });

    const result = store.listSessionEvents({ session_id: session.id, type: "note" });
    assert.equal(result.events[0].summary, "first");
    assert.equal(result.events[1].summary, "second");
  });
});

test("listSessionEvents returns empty for unknown session_id", async () => {
  await withStore((store) => {
    const result = store.listSessionEvents({ session_id: "ses_nope" });
    assert.deepEqual(result.events, []);
    assert.equal(result.total, 0);
  });
});

test("checkpointSession overwrites rolling_summary and keeps the session active", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Checkpoint",
      harness: "hermes",
    });

    const result = store.checkpointSession({
      agent_id: "bede",
      session_id: session.id,
      summary: "Formalised the session model.",
      decisions: ["Use lib: prefix"],
      next_steps: ["Implement session event projection"],
      files_touched: ["src/store.js"],
      commands_run: ["npm test"],
      open_questions: ["Do we need fts on lifecycle events?"],
    });

    assert.equal(result.session.status, "active");
    assert.equal(result.session.rolling_summary, "Formalised the session model.");
    assert.deepEqual(result.session.next_steps, ["Implement session event projection"]);

    store.checkpointSession({
      agent_id: "bede",
      session_id: session.id,
      summary: "Newer snapshot.",
    });
    assert.equal(store.getSession(session.id).rolling_summary, "Newer snapshot.");
  });
});

test("pauseSession marks the session paused, updates rolling_summary, and sets paused_at", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Pause me",
      harness: "hermes",
    });

    const result = store.pauseSession({
      agent_id: "bede",
      session_id: session.id,
      summary: "Stepping away.",
    });

    assert.equal(result.session.status, "paused");
    assert.equal(result.session.rolling_summary, "Stepping away.");
    assert.ok(result.session.paused_at);
  });
});

test("recording an event on a paused session implicitly resumes it", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Implicit resume",
      harness: "hermes",
    });
    store.pauseSession({ agent_id: "bede", session_id: session.id, summary: "Pause." });
    assert.equal(store.getSession(session.id).status, "paused");

    store.recordSessionEvent({
      agent_id: "bede",
      session_id: session.id,
      type: "note",
      summary: "Back at it.",
    });

    const reloaded = store.getSession(session.id);
    assert.equal(reloaded.status, "active");
    assert.equal(reloaded.paused_at, null);
  });
});

test("checkpointing a paused session implicitly resumes it", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Resume via checkpoint",
      harness: "hermes",
    });
    store.pauseSession({ agent_id: "bede", session_id: session.id, summary: "Pause." });

    store.checkpointSession({
      agent_id: "bede",
      session_id: session.id,
      summary: "Picking back up.",
    });

    const reloaded = store.getSession(session.id);
    assert.equal(reloaded.status, "active");
    assert.equal(reloaded.paused_at, null);
    assert.equal(reloaded.rolling_summary, "Picking back up.");
  });
});

test("endSession writes end_summary, freezes rolling_summary, and marks the session ended", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "End me",
      harness: "hermes",
    });
    store.checkpointSession({
      agent_id: "bede",
      session_id: session.id,
      summary: "Midway snapshot.",
    });

    const result = store.endSession({
      agent_id: "bede",
      session_id: session.id,
      summary: "All done.",
      decisions: ["Final decision"],
      next_steps: ["Open the PR"],
    });

    assert.equal(result.session.status, "ended");
    assert.equal(result.session.end_summary, "All done.");
    assert.equal(
      result.session.rolling_summary,
      "Midway snapshot.",
      "rolling_summary should be frozen at the final checkpoint",
    );
    assert.deepEqual(result.session.next_steps, ["Open the PR"]);
    assert.ok(result.session.ended_at);
  });
});

test("ended sessions reject checkpoint, pause, end, and record_event", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Sealed",
      harness: "hermes",
    });
    store.endSession({ agent_id: "bede", session_id: session.id, summary: "Done." });

    assert.throws(
      () => store.checkpointSession({ agent_id: "bede", session_id: session.id, summary: "x" }),
      /ended|status|transition/i,
    );
    assert.throws(
      () => store.pauseSession({ agent_id: "bede", session_id: session.id, summary: "x" }),
      /ended|status|transition/i,
    );
    assert.throws(
      () => store.endSession({ agent_id: "bede", session_id: session.id, summary: "x" }),
      /ended|status|transition/i,
    );
    assert.throws(
      () =>
        store.recordSessionEvent({
          agent_id: "bede",
          session_id: session.id,
          type: "note",
          summary: "x",
        }),
      /ended|status|terminal|transition/i,
    );
  });
});

test("archiveSession records prior_status and hides from default list", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Archive me",
      harness: "hermes",
    });

    const result = store.archiveSession({
      agent_id: "bede",
      session_id: session.id,
      reason: "throwaway spike",
    });

    assert.equal(result.session.status, "archived");
    assert.equal(result.session.prior_status, "active");
    assert.ok(result.session.archived_at);

    assert.equal(store.listSessions({ agent_id: "bede" }).sessions.length, 0);
    assert.equal(
      store.listSessions({ agent_id: "bede", include_archived: true }).sessions.length,
      1,
    );
  });
});

test("restoreSession returns an archived session to its prior_status and clears archived_at", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Restore me",
      harness: "hermes",
    });
    store.pauseSession({ agent_id: "bede", session_id: session.id, summary: "Pause." });
    store.archiveSession({ agent_id: "bede", session_id: session.id, reason: "x" });
    assert.equal(store.getSession(session.id).status, "archived");
    assert.equal(store.getSession(session.id).prior_status, "paused");

    const result = store.restoreSession({ agent_id: "bede", session_id: session.id });

    assert.equal(result.session.status, "paused");
    assert.equal(result.session.archived_at, null);
    assert.equal(result.session.prior_status, null, "prior_status should be cleared after restore");
  });
});

test("deleteSession soft-deletes and hides from default list (visible with include_deleted)", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Delete me",
      harness: "hermes",
    });

    const result = store.deleteSession({
      agent_id: "bede",
      session_id: session.id,
      reason: "test session",
    });

    assert.equal(result.session.status, "deleted");
    assert.equal(result.session.prior_status, "active");
    assert.ok(result.session.deleted_at);

    assert.equal(store.listSessions({ agent_id: "bede" }).sessions.length, 0);
    assert.equal(
      store.listSessions({ agent_id: "bede", include_deleted: true }).sessions.length,
      1,
    );
  });
});

test("deleteSession refuses non-owner callers without admin role", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Bede's",
      harness: "hermes",
    });

    assert.throws(
      () => store.deleteSession({ agent_id: "codex", session_id: session.id, reason: "x" }),
      /owner|permission|admin/i,
    );
    assert.equal(store.getSession(session.id).status, "active");
  });
});

test("admin role can delete sessions owned by other agents", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Bede's",
      harness: "hermes",
    });
    const result = store.deleteSession({
      agent_id: "dashboard",
      session_id: session.id,
      admin: true,
      reason: "admin cleanup",
    });
    assert.equal(result.session.status, "deleted");
  });
});

test("restoreSession refuses non-owner callers without admin role", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Bede's",
      harness: "hermes",
    });
    store.archiveSession({ agent_id: "bede", session_id: session.id, reason: "x" });

    assert.throws(
      () => store.restoreSession({ agent_id: "codex", session_id: session.id }),
      /owner|permission|admin/i,
    );
    assert.equal(store.getSession(session.id).status, "archived");
  });
});

test("deleting an archived session preserves the original prior_status and round-trips through restore", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Two hops",
      harness: "hermes",
    });
    store.endSession({ agent_id: "bede", session_id: session.id, summary: "Done." });
    store.archiveSession({ agent_id: "bede", session_id: session.id, reason: "tidy" });
    assert.equal(store.getSession(session.id).prior_status, "ended");

    store.deleteSession({ agent_id: "bede", session_id: session.id, reason: "purge" });
    assert.equal(
      store.getSession(session.id).prior_status,
      "ended",
      "prior_status should not be overwritten when transitioning between hidden states",
    );

    const restored = store.restoreSession({ agent_id: "bede", session_id: session.id });
    assert.equal(restored.session.status, "ended");
    assert.equal(restored.session.deleted_at, null);
  });
});

test("ended sessions can still be archived or deleted", async () => {
  await withStore((store) => {
    const { session: a } = store.startSession({
      agent_id: "bede",
      title: "End-then-archive",
      harness: "hermes",
    });
    store.endSession({ agent_id: "bede", session_id: a.id, summary: "Done." });
    const archived = store.archiveSession({ agent_id: "bede", session_id: a.id, reason: "tidy" });
    assert.equal(archived.session.status, "archived");

    const { session: b } = store.startSession({
      agent_id: "bede",
      title: "End-then-delete",
      harness: "hermes",
    });
    store.endSession({ agent_id: "bede", session_id: b.id, summary: "Done." });
    const deleted = store.deleteSession({ agent_id: "bede", session_id: b.id });
    assert.equal(deleted.session.status, "deleted");
  });
});

test("attachSession overwrites current_harness/current_agent_id/source_ref/cwd and appends an event", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Attach me",
      harness: "hermes",
      source_ref: "discord:channel:1:thread:2",
      cwd: "/old/path",
    });

    const result = store.attachSession({
      session_id: session.id,
      agent_id: "codex",
      harness: "codex",
      source_ref: "codex:run:r1:cwd:/new/path",
      cwd: "/new/path",
    });

    assert.equal(result.session.current_agent_id, "codex");
    assert.equal(result.session.current_harness, "codex");
    assert.equal(result.session.source_ref, "codex:run:r1:cwd:/new/path");
    assert.equal(result.session.cwd, "/new/path");
    assert.equal(result.session.created_by_agent_id, "bede", "owner preserved");
    assert.equal(result.session.created_in_harness, "hermes", "origin preserved");

    const events = store.listSessionEvents({ session_id: session.id });
    assert.ok(events.events.some((event) => event.type === "attached_to_harness"));
  });
});

test("attachSession refuses ended or archived sessions", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Sealed",
      harness: "hermes",
    });
    store.endSession({ agent_id: "bede", session_id: session.id, summary: "Done." });
    assert.throws(
      () => store.attachSession({ session_id: session.id, agent_id: "codex", harness: "codex" }),
      /ended|status/i,
    );
  });
});

test("continueSession returns a handover with original and current harness/source, plus aggregated decisions", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Handover content",
      harness: "hermes",
      project_key: "the-librarian",
      source_ref: "discord:channel:1:thread:2",
      cwd: "/home/jim/the-librarian",
      start_summary: "Designing the session layer.",
    });
    store.checkpointSession({
      agent_id: "bede",
      session_id: session.id,
      summary: "Drafted handover behaviour.",
      decisions: ["Default attach=true", "Numbered IDs are agent-side scratch"],
      files_touched: ["src/store.js"],
      commands_run: ["npm test"],
      open_questions: ["Aggregate across paused sessions?"],
      next_steps: ["Add tests for restore"],
    });
    store.recordSessionEvent({
      agent_id: "bede",
      session_id: session.id,
      type: "decision",
      summary: "Use prose as default format",
    });

    const result = store.continueSession({
      agent_id: "codex",
      session_id: session.id,
      target_harness: "codex",
      target_source_ref: "codex:run:r1:cwd:/dev",
      target_cwd: "/dev",
      attach: true,
    });

    assert.equal(result.session.current_harness, "codex");
    assert.equal(result.session.current_agent_id, "codex");
    assert.equal(result.session.cwd, "/dev");
    assert.equal(result.session.source_ref, "codex:run:r1:cwd:/dev");

    assert.equal(result.handover.title, "Handover content");
    assert.equal(result.handover.project_key, "the-librarian");
    assert.equal(result.handover.created_in_harness, "hermes");
    assert.equal(result.handover.created_source_ref, "discord:channel:1:thread:2");
    assert.equal(result.handover.current_harness, "codex");
    assert.equal(result.handover.current_source_ref, "codex:run:r1:cwd:/dev");
    assert.equal(result.handover.start_summary, "Designing the session layer.");
    assert.equal(result.handover.rolling_summary, "Drafted handover behaviour.");
    assert.deepEqual(result.handover.next_steps, ["Add tests for restore"]);
    assert.ok(result.handover.decisions.includes("Default attach=true"));
    assert.ok(result.handover.decisions.includes("Use prose as default format"));
    assert.ok(result.handover.files_touched.includes("src/store.js"));
    assert.ok(result.handover.commands_run.includes("npm test"));

    assert.ok(result.text.includes("Handover content"));
    assert.ok(result.text.includes("codex"));
  });
});

test("continueSession with attach=false leaves current_harness untouched", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Preview only",
      harness: "hermes",
      source_ref: "discord:1:2",
    });

    const result = store.continueSession({
      agent_id: "codex",
      session_id: session.id,
      target_harness: "codex",
      target_source_ref: "codex:r1",
      attach: false,
    });

    assert.equal(result.session.current_harness, "hermes");
    assert.equal(result.session.current_agent_id, "bede");
    assert.equal(result.session.source_ref, "discord:1:2");
    assert.equal(result.handover.current_harness, "hermes");
  });
});

test("continueSession does not append an attach event when target matches current", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Same place",
      harness: "hermes",
      source_ref: "discord:1:2",
    });
    const before = store.listSessionEvents({ session_id: session.id }).total;

    store.continueSession({
      agent_id: "bede",
      session_id: session.id,
      target_harness: "hermes",
      target_source_ref: "discord:1:2",
      attach: true,
    });

    const after = store.listSessionEvents({ session_id: session.id }).total;
    assert.equal(after, before, "no attach event when target matches current");
  });
});

test("continueSession with format=markdown renders the spec's handover sections", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Markdown render",
      harness: "hermes",
      project_key: "the-librarian",
      start_summary: "Starting.",
    });
    store.checkpointSession({
      agent_id: "bede",
      session_id: session.id,
      summary: "Mid.",
      decisions: ["Decision A"],
      files_touched: ["src/store.js"],
      commands_run: ["npm test"],
      open_questions: ["Q1?"],
      next_steps: ["Next A"],
    });

    const result = store.continueSession({
      agent_id: "bede",
      session_id: session.id,
      target_harness: "claude-code",
      format: "markdown",
      attach: false,
    });

    assert.ok(result.text.includes("# Librarian Session Handover"));
    assert.ok(result.text.includes("Markdown render"));
    assert.ok(result.text.includes("## Decisions"));
    assert.ok(result.text.includes("Decision A"));
    assert.ok(result.text.includes("src/store.js"));
    assert.ok(result.text.includes("npm test"));
    assert.ok(result.text.includes("Q1?"));
    assert.ok(result.text.includes("Next A"));
  });
});

test("continueSession on an ended session works with attach=false but throws with attach=true", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Done",
      harness: "hermes",
    });
    store.endSession({ agent_id: "bede", session_id: session.id, summary: "Done." });

    const preview = store.continueSession({
      agent_id: "codex",
      session_id: session.id,
      target_harness: "codex",
      attach: false,
    });
    assert.equal(preview.handover.status, "ended");

    assert.throws(
      () =>
        store.continueSession({
          agent_id: "codex",
          session_id: session.id,
          target_harness: "codex",
          attach: true,
        }),
      /ended|status/i,
    );
  });
});

test("searchSessions finds sessions whose event summaries contain matching tokens", async () => {
  await withStore((store) => {
    const { session: target } = store.startSession({
      agent_id: "bede",
      title: "Findable",
      harness: "hermes",
      start_summary: "Investigate BM25 recall trade-offs.",
    });
    store.startSession({
      agent_id: "bede",
      title: "Other",
      harness: "hermes",
      start_summary: "Refactor the dashboard layout.",
    });

    const result = store.searchSessions({ agent_id: "bede", query: "BM25" });
    const ids = result.sessions.map((s) => s.id);
    assert.ok(ids.includes(target.id));
    assert.equal(ids.length, 1);
  });
});

test("searchSessions finds sessions by checkpoint summary content", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Search target",
      harness: "hermes",
    });
    store.checkpointSession({
      agent_id: "bede",
      session_id: session.id,
      summary: "Decided to use BM25 ranking for recall.",
    });

    const result = store.searchSessions({ agent_id: "bede", query: "BM25" });
    assert.ok(result.sessions.some((s) => s.id === session.id));
  });
});

test("searchSessions excludes archived sessions by default and shows them with include_archived", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Findable archived",
      harness: "hermes",
      start_summary: "Investigate BM25 recall.",
    });
    store.archiveSession({ agent_id: "bede", session_id: session.id, reason: "tidy" });

    const def = store.searchSessions({ agent_id: "bede", query: "BM25" });
    assert.equal(def.sessions.length, 0);

    const inc = store.searchSessions({ agent_id: "bede", query: "BM25", include_archived: true });
    assert.equal(inc.sessions.length, 1);
  });
});

test("searchSessions excludes deleted sessions and only admins may opt them in", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Findable deleted",
      harness: "hermes",
      start_summary: "Investigate BM25 recall.",
    });
    store.deleteSession({ agent_id: "bede", session_id: session.id });

    const def = store.searchSessions({ agent_id: "bede", query: "BM25" });
    assert.equal(def.sessions.length, 0);

    const nonAdmin = store.searchSessions({
      agent_id: "bede",
      query: "BM25",
      include_deleted: true,
    });
    assert.equal(nonAdmin.sessions.length, 0, "non-admin include_deleted should be ignored");

    const admin = store.searchSessions({
      agent_id: "dashboard",
      query: "BM25",
      include_deleted: true,
      admin: true,
    });
    assert.equal(admin.sessions.length, 1);
  });
});

test("searchSessions hides agent_private sessions belonging to other agents", async () => {
  await withStore((store) => {
    const { session: priv } = store.startSession({
      agent_id: "codex",
      title: "Codex priv",
      harness: "codex",
      visibility: "agent_private",
      start_summary: "Investigate BM25 recall.",
    });

    const asBede = store.searchSessions({ agent_id: "bede", query: "BM25" });
    assert.equal(asBede.sessions.length, 0);

    const asCodex = store.searchSessions({ agent_id: "codex", query: "BM25" });
    assert.equal(asCodex.sessions.length, 1);
    assert.equal(asCodex.sessions[0].id, priv.id);
  });
});

test("searchSessions filters by project_key when supplied", async () => {
  await withStore((store) => {
    store.startSession({
      agent_id: "bede",
      title: "Project alpha",
      harness: "hermes",
      project_key: "alpha",
      start_summary: "Investigate BM25 recall.",
    });
    store.startSession({
      agent_id: "bede",
      title: "Project beta",
      harness: "hermes",
      project_key: "beta",
      start_summary: "Investigate BM25 recall.",
    });

    const alpha = store.searchSessions({
      agent_id: "bede",
      query: "BM25",
      project_key: "alpha",
    });
    assert.equal(alpha.sessions.length, 1);
    assert.equal(alpha.sessions[0].project_key, "alpha");
  });
});

test("searchSessions returns an empty result for a blank query", async () => {
  await withStore((store) => {
    store.startSession({ agent_id: "bede", title: "Test", harness: "hermes" });
    const result = store.searchSessions({ agent_id: "bede", query: "" });
    assert.equal(result.sessions.length, 0);
    assert.equal(result.total, 0);
  });
});

test("promoteSessionFact creates an active memory for non-protected categories and records the link", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Promote test",
      harness: "hermes",
    });

    const result = store.promoteSessionFact({
      agent_id: "bede",
      session_id: session.id,
      memory: {
        title: "Use lib: prefix for session commands",
        body: "Slash commands for sessions are prefixed with lib: to avoid harness conflicts.",
        category: "tools",
        visibility: "common",
        scope: "tool",
        project_key: "the-librarian",
      },
    });

    assert.equal(result.status, "active");
    assert.equal(result.memory.status, "active");
    assert.equal(result.memory.title, "Use lib: prefix for session commands");
    assert.equal(result.session_id, session.id);

    const events = store.listSessionEvents({ session_id: session.id });
    const promo = events.events.find((event) => event.type === "promoted_to_memory");
    assert.ok(promo, "session.promoted_to_memory event must exist");
    assert.equal(promo.payload.memory_id, result.memory.id);
  });
});

test("promoteSessionFact routes protected categories through the proposal flow", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Protected promote",
      harness: "hermes",
    });

    const result = store.promoteSessionFact({
      agent_id: "bede",
      session_id: session.id,
      memory: {
        title: "User prefers terse responses",
        body: "Jim asked for terse output across multiple sessions.",
        category: "identity",
        visibility: "common",
        scope: "global",
      },
    });

    assert.equal(result.status, "proposed");
    assert.equal(result.memory.status, "proposed");
  });
});

test("promoteSessionFact stores session_event_id on the promotion event when supplied", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Link event",
      harness: "hermes",
    });
    const decision = store.recordSessionEvent({
      agent_id: "bede",
      session_id: session.id,
      type: "decision",
      summary: "Source decision.",
    });

    const result = store.promoteSessionFact({
      agent_id: "bede",
      session_id: session.id,
      session_event_id: decision.event_id,
      memory: {
        title: "Lifted source decision",
        body: "Promoting the decision recorded earlier in this session.",
        category: "lessons",
        visibility: "common",
      },
    });

    assert.equal(result.session_event_id, decision.event_id);
    const events = store.listSessionEvents({ session_id: session.id });
    const promo = events.events.find((event) => event.type === "promoted_to_memory");
    assert.equal(promo.payload.session_event_id, decision.event_id);
  });
});

test("promoteSessionFact throws for unknown session_id", async () => {
  await withStore((store) => {
    assert.throws(
      () =>
        store.promoteSessionFact({
          agent_id: "bede",
          session_id: "ses_nope",
          memory: { title: "x", body: "x", category: "tools" },
        }),
      /session/i,
    );
  });
});

test("promoteSessionFact does not create the memory when the input lacks both title and body", async () => {
  await withStore((store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Empty input",
      harness: "hermes",
    });
    assert.throws(
      () =>
        store.promoteSessionFact({
          agent_id: "bede",
          session_id: session.id,
          memory: { category: "tools" },
        }),
      /title|body|memory/i,
    );
  });
});

// Rebuild-parity tests moved to packages/core/tests/store/projection.test.ts
// in T3.2 (Vitest).
