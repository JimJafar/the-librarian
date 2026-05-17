import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { withStore } from "./helpers.js";

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
      tags: ["sessions", "librarian"]
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
      harness: "codex"
    });
    assert.match(fromProject.session.title, /^the-librarian session @ /);

    const fromHarness = store.startSession({
      agent_id: "bede",
      harness: "codex"
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
      visibility: "agent_private"
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
      harness: "hermes"
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
      scope: "tool"
    });
    store.startSession({ agent_id: "bede", title: "Session still works", harness: "hermes" });

    const memEvents = fs.readFileSync(path.join(dataDir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean);
    const sessEvents = fs.readFileSync(path.join(dataDir, "sessions.jsonl"), "utf8").trim().split("\n").filter(Boolean);
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
      project_key: "other-repo"
    });
    const target = store.startSession({
      agent_id: "bede",
      title: "Target project",
      harness: "hermes",
      project_key: "the-librarian"
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
      cwd: "/somewhere/else"
    });
    const sameProjSameSrc = store.startSession({
      agent_id: "bede",
      title: "Same proj, same cwd",
      harness: "hermes",
      project_key: "the-librarian",
      cwd: "/home/jim/the-librarian"
    });

    const result = store.listSessions({
      agent_id: "bede",
      project_key: "the-librarian",
      cwd: "/home/jim/the-librarian"
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
      source_ref: "discord:channel:1:thread:2"
    });
    const matchingSrc = store.startSession({
      agent_id: "bede",
      title: "Matching thread",
      harness: "hermes",
      source_ref: "discord:channel:9:thread:42"
    });

    const result = store.listSessions({
      agent_id: "bede",
      source_ref: "discord:channel:9:thread:42"
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
      visibility: "common"
    });
    const bedePrivate = store.startSession({
      agent_id: "bede",
      title: "Bede private",
      harness: "hermes",
      visibility: "agent_private"
    });
    const codexPrivate = store.startSession({
      agent_id: "codex",
      title: "Codex private",
      harness: "codex",
      visibility: "agent_private"
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
      visibility: "agent_private"
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
      [third.session.id, second.session.id, first.session.id]
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
    const { session } = store.startSession({ agent_id: "bede", title: "Recording", harness: "hermes" });
    const initialActivity = session.last_activity_at;

    await new Promise((resolve) => setTimeout(resolve, 5));

    const event = store.recordSessionEvent({
      agent_id: "bede",
      session_id: session.id,
      harness: "hermes",
      type: "decision",
      summary: "Use list-and-select rather than latest-inference.",
      payload: { confidence: "confirmed" }
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
    const { session } = store.startSession({ agent_id: "bede", title: "Reject", harness: "hermes" });
    assert.throws(
      () => store.recordSessionEvent({
        agent_id: "bede",
        session_id: session.id,
        type: "garbage",
        summary: "x"
      }),
      /payload type/i
    );
  });
});

test("recordSessionEvent throws for unknown session_id", async () => {
  await withStore((store) => {
    assert.throws(
      () => store.recordSessionEvent({
        agent_id: "bede",
        session_id: "ses_nope",
        type: "note",
        summary: "x"
      }),
      /session/i
    );
  });
});

test("listSessionEvents returns events with pagination and type filter", async () => {
  await withStore((store) => {
    const { session } = store.startSession({ agent_id: "bede", title: "Listing", harness: "hermes" });

    store.recordSessionEvent({ agent_id: "bede", session_id: session.id, type: "decision", summary: "d1" });
    store.recordSessionEvent({ agent_id: "bede", session_id: session.id, type: "command", summary: "c1" });
    store.recordSessionEvent({ agent_id: "bede", session_id: session.id, type: "decision", summary: "d2" });
    store.recordSessionEvent({ agent_id: "bede", session_id: session.id, type: "note", summary: "n1" });

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
    store.recordSessionEvent({ agent_id: "bede", session_id: session.id, type: "note", summary: "first" });
    await new Promise((resolve) => setTimeout(resolve, 2));
    store.recordSessionEvent({ agent_id: "bede", session_id: session.id, type: "note", summary: "second" });

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
    const { session } = store.startSession({ agent_id: "bede", title: "Checkpoint", harness: "hermes" });

    const result = store.checkpointSession({
      agent_id: "bede",
      session_id: session.id,
      summary: "Formalised the session model.",
      decisions: ["Use lib: prefix"],
      next_steps: ["Implement session event projection"],
      files_touched: ["src/store.js"],
      commands_run: ["npm test"],
      open_questions: ["Do we need fts on lifecycle events?"]
    });

    assert.equal(result.session.status, "active");
    assert.equal(result.session.rolling_summary, "Formalised the session model.");
    assert.deepEqual(result.session.next_steps, ["Implement session event projection"]);

    store.checkpointSession({
      agent_id: "bede",
      session_id: session.id,
      summary: "Newer snapshot."
    });
    assert.equal(store.getSession(session.id).rolling_summary, "Newer snapshot.");
  });
});

test("pauseSession marks the session paused, updates rolling_summary, and sets paused_at", async () => {
  await withStore((store) => {
    const { session } = store.startSession({ agent_id: "bede", title: "Pause me", harness: "hermes" });

    const result = store.pauseSession({
      agent_id: "bede",
      session_id: session.id,
      summary: "Stepping away."
    });

    assert.equal(result.session.status, "paused");
    assert.equal(result.session.rolling_summary, "Stepping away.");
    assert.ok(result.session.paused_at);
  });
});

test("recording an event on a paused session implicitly resumes it", async () => {
  await withStore((store) => {
    const { session } = store.startSession({ agent_id: "bede", title: "Implicit resume", harness: "hermes" });
    store.pauseSession({ agent_id: "bede", session_id: session.id, summary: "Pause." });
    assert.equal(store.getSession(session.id).status, "paused");

    store.recordSessionEvent({
      agent_id: "bede",
      session_id: session.id,
      type: "note",
      summary: "Back at it."
    });

    const reloaded = store.getSession(session.id);
    assert.equal(reloaded.status, "active");
    assert.equal(reloaded.paused_at, null);
  });
});

test("checkpointing a paused session implicitly resumes it", async () => {
  await withStore((store) => {
    const { session } = store.startSession({ agent_id: "bede", title: "Resume via checkpoint", harness: "hermes" });
    store.pauseSession({ agent_id: "bede", session_id: session.id, summary: "Pause." });

    store.checkpointSession({
      agent_id: "bede",
      session_id: session.id,
      summary: "Picking back up."
    });

    const reloaded = store.getSession(session.id);
    assert.equal(reloaded.status, "active");
    assert.equal(reloaded.paused_at, null);
    assert.equal(reloaded.rolling_summary, "Picking back up.");
  });
});

test("endSession writes end_summary, freezes rolling_summary, and marks the session ended", async () => {
  await withStore((store) => {
    const { session } = store.startSession({ agent_id: "bede", title: "End me", harness: "hermes" });
    store.checkpointSession({
      agent_id: "bede",
      session_id: session.id,
      summary: "Midway snapshot."
    });

    const result = store.endSession({
      agent_id: "bede",
      session_id: session.id,
      summary: "All done.",
      decisions: ["Final decision"],
      next_steps: ["Open the PR"]
    });

    assert.equal(result.session.status, "ended");
    assert.equal(result.session.end_summary, "All done.");
    assert.equal(
      result.session.rolling_summary,
      "Midway snapshot.",
      "rolling_summary should be frozen at the final checkpoint"
    );
    assert.deepEqual(result.session.next_steps, ["Open the PR"]);
    assert.ok(result.session.ended_at);
  });
});

test("ended sessions reject checkpoint, pause, end, and record_event", async () => {
  await withStore((store) => {
    const { session } = store.startSession({ agent_id: "bede", title: "Sealed", harness: "hermes" });
    store.endSession({ agent_id: "bede", session_id: session.id, summary: "Done." });

    assert.throws(
      () => store.checkpointSession({ agent_id: "bede", session_id: session.id, summary: "x" }),
      /ended|status|transition/i
    );
    assert.throws(
      () => store.pauseSession({ agent_id: "bede", session_id: session.id, summary: "x" }),
      /ended|status|transition/i
    );
    assert.throws(
      () => store.endSession({ agent_id: "bede", session_id: session.id, summary: "x" }),
      /ended|status|transition/i
    );
    assert.throws(
      () => store.recordSessionEvent({ agent_id: "bede", session_id: session.id, type: "note", summary: "x" }),
      /ended|status|terminal|transition/i
    );
  });
});

test("archiveSession records prior_status and hides from default list", async () => {
  await withStore((store) => {
    const { session } = store.startSession({ agent_id: "bede", title: "Archive me", harness: "hermes" });

    const result = store.archiveSession({
      agent_id: "bede",
      session_id: session.id,
      reason: "throwaway spike"
    });

    assert.equal(result.session.status, "archived");
    assert.equal(result.session.prior_status, "active");
    assert.ok(result.session.archived_at);

    assert.equal(store.listSessions({ agent_id: "bede" }).sessions.length, 0);
    assert.equal(store.listSessions({ agent_id: "bede", include_archived: true }).sessions.length, 1);
  });
});

test("restoreSession returns an archived session to its prior_status and clears archived_at", async () => {
  await withStore((store) => {
    const { session } = store.startSession({ agent_id: "bede", title: "Restore me", harness: "hermes" });
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
    const { session } = store.startSession({ agent_id: "bede", title: "Delete me", harness: "hermes" });

    const result = store.deleteSession({
      agent_id: "bede",
      session_id: session.id,
      reason: "test session"
    });

    assert.equal(result.session.status, "deleted");
    assert.equal(result.session.prior_status, "active");
    assert.ok(result.session.deleted_at);

    assert.equal(store.listSessions({ agent_id: "bede" }).sessions.length, 0);
    assert.equal(
      store.listSessions({ agent_id: "bede", include_deleted: true }).sessions.length,
      1
    );
  });
});

test("deleteSession refuses non-owner callers without admin role", async () => {
  await withStore((store) => {
    const { session } = store.startSession({ agent_id: "bede", title: "Bede's", harness: "hermes" });

    assert.throws(
      () => store.deleteSession({ agent_id: "codex", session_id: session.id, reason: "x" }),
      /owner|permission|admin/i
    );
    assert.equal(store.getSession(session.id).status, "active");
  });
});

test("admin role can delete sessions owned by other agents", async () => {
  await withStore((store) => {
    const { session } = store.startSession({ agent_id: "bede", title: "Bede's", harness: "hermes" });
    const result = store.deleteSession({
      agent_id: "dashboard",
      session_id: session.id,
      admin: true,
      reason: "admin cleanup"
    });
    assert.equal(result.session.status, "deleted");
  });
});

test("restoreSession refuses non-owner callers without admin role", async () => {
  await withStore((store) => {
    const { session } = store.startSession({ agent_id: "bede", title: "Bede's", harness: "hermes" });
    store.archiveSession({ agent_id: "bede", session_id: session.id, reason: "x" });

    assert.throws(
      () => store.restoreSession({ agent_id: "codex", session_id: session.id }),
      /owner|permission|admin/i
    );
    assert.equal(store.getSession(session.id).status, "archived");
  });
});

test("deleting an archived session preserves the original prior_status and round-trips through restore", async () => {
  await withStore((store) => {
    const { session } = store.startSession({ agent_id: "bede", title: "Two hops", harness: "hermes" });
    store.endSession({ agent_id: "bede", session_id: session.id, summary: "Done." });
    store.archiveSession({ agent_id: "bede", session_id: session.id, reason: "tidy" });
    assert.equal(store.getSession(session.id).prior_status, "ended");

    store.deleteSession({ agent_id: "bede", session_id: session.id, reason: "purge" });
    assert.equal(
      store.getSession(session.id).prior_status,
      "ended",
      "prior_status should not be overwritten when transitioning between hidden states"
    );

    const restored = store.restoreSession({ agent_id: "bede", session_id: session.id });
    assert.equal(restored.session.status, "ended");
    assert.equal(restored.session.deleted_at, null);
  });
});

test("ended sessions can still be archived or deleted", async () => {
  await withStore((store) => {
    const { session: a } = store.startSession({ agent_id: "bede", title: "End-then-archive", harness: "hermes" });
    store.endSession({ agent_id: "bede", session_id: a.id, summary: "Done." });
    const archived = store.archiveSession({ agent_id: "bede", session_id: a.id, reason: "tidy" });
    assert.equal(archived.session.status, "archived");

    const { session: b } = store.startSession({ agent_id: "bede", title: "End-then-delete", harness: "hermes" });
    store.endSession({ agent_id: "bede", session_id: b.id, summary: "Done." });
    const deleted = store.deleteSession({ agent_id: "bede", session_id: b.id });
    assert.equal(deleted.session.status, "deleted");
  });
});
