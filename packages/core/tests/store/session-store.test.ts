// Session-store behavior tests.
//
// Migrated from packages/core/tests/sessions.test.js as part of T3.4.
// Behavior coverage is identical to the pre-migration suite — these tests
// pin the lifecycle, projection, handover, search, and promote-to-memory
// contracts of the session surface.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LibrarianStore, createLibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface ScopedStore {
  store: LibrarianStore;
  dataDir: string;
}

function makeScopedStore(): ScopedStore {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-session-store-"));
  const store = createLibrarianStore({ dataDir });
  return { store, dataDir };
}

function teardown(scope: ScopedStore | null): void {
  if (!scope) return;
  try {
    scope.store.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(scope.dataDir, { recursive: true, force: true });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("LibrarianStore session lifecycle", () => {
  let scope: ScopedStore | null = null;

  beforeEach(() => {
    scope = makeScopedStore();
  });

  afterEach(() => {
    teardown(scope);
    scope = null;
  });

  it("startSession creates an active common session with the supplied fields", () => {
    const { store } = scope!;
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
    expect(session.id.startsWith("ses_")).toBe(true);
    expect(session.title).toBe("Cross-harness recall design");
    expect(session.project_key).toBe("the-librarian");
    expect(session.status).toBe("active");
    expect(session.prior_status).toBeNull();
    expect(session.visibility).toBe("common");
    expect(session.created_by_agent_id).toBe("bede");
    expect(session.current_agent_id).toBe("bede");
    expect(session.created_in_harness).toBe("hermes");
    expect(session.current_harness).toBe("hermes");
    expect(session.source_ref).toBe("discord:channel:1:thread:2");
    expect(session.cwd).toBe("/home/jim/the-librarian");
    expect(session.capture_mode).toBe("summary");
    expect(session.start_summary).toBe("Sketch the session layer.");
    expect(session.rolling_summary).toBeNull();
    expect(session.end_summary).toBeNull();
    expect(session.next_steps).toEqual([]);
    expect(session.tags).toEqual(["sessions", "librarian"]);
    expect(session.started_at).toBeTruthy();
    expect(session.updated_at).toBe(session.started_at);
    expect(session.last_activity_at).toBe(session.started_at);
    expect(session.paused_at).toBeNull();
    expect(session.ended_at).toBeNull();
    expect(session.archived_at).toBeNull();
    expect(session.deleted_at).toBeNull();
    expect(session.metadata).toEqual({});
  });

  it("startSession generates a placeholder title when one is not supplied", () => {
    const { store } = scope!;
    const fromProject = store.startSession({
      agent_id: "bede",
      project_key: "the-librarian",
      harness: "codex",
    });
    expect(fromProject.session.title).toMatch(/^the-librarian session @ /);

    const fromHarness = store.startSession({
      agent_id: "bede",
      harness: "codex",
    });
    expect(fromHarness.session.title).toMatch(/^codex session @ /);
  });

  it("startSession defaults visibility to common and capture_mode to summary", () => {
    const { store } = scope!;
    const result = store.startSession({ agent_id: "bede", title: "Defaults", harness: "hermes" });
    expect(result.session.visibility).toBe("common");
    expect(result.session.capture_mode).toBe("summary");
  });

  it("startSession accepts an explicit agent_private visibility", () => {
    const { store } = scope!;
    const result = store.startSession({
      agent_id: "bede",
      title: "Private spike",
      harness: "hermes",
      visibility: "agent_private",
    });
    expect(result.session.visibility).toBe("agent_private");
  });

  it("startSession appends a session.started event to sessions.jsonl and inserts a row in the projection", () => {
    const { store, dataDir } = scope!;
    const sessionsPath = path.join(dataDir, "sessions.jsonl");
    expect(fs.existsSync(sessionsPath)).toBe(true);

    const result = store.startSession({
      agent_id: "bede",
      title: "Event projection",
      harness: "hermes",
    });

    const lines = fs.readFileSync(sessionsPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const event = JSON.parse(lines[0]);
    expect(event.event_type).toBe("session.started");
    expect(event.session_id).toBe(result.session.id);
    expect(event.agent_id).toBe("bede");
    expect(event.created_at).toBeTruthy();
    expect(event.payload?.session?.id).toBeTruthy();

    const fetched = store.getSession(result.session.id);
    expect(fetched.id).toBe(result.session.id);
    expect(fetched.title).toBe("Event projection");
  });

  it("getSession returns null for an unknown id and does not throw", () => {
    const { store } = scope!;
    expect(store.getSession("ses_does_not_exist")).toBeNull();
  });

  it("multiple active sessions can coexist", () => {
    const { store } = scope!;
    const first = store.startSession({ agent_id: "bede", title: "First", harness: "hermes" });
    const second = store.startSession({ agent_id: "codex", title: "Second", harness: "codex" });
    expect(first.session.id).not.toBe(second.session.id);
    expect(store.getSession(first.session.id).status).toBe("active");
    expect(store.getSession(second.session.id).status).toBe("active");
  });

  it("memory writes do not touch the session projection (and vice versa)", () => {
    const { store, dataDir } = scope!;
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
    expect(memEvents.length).toBe(1);
    expect(sessEvents.length).toBe(1);
  });
});

describe("LibrarianStore listSessions", () => {
  let scope: ScopedStore | null = null;

  beforeEach(() => {
    scope = makeScopedStore();
  });

  afterEach(() => {
    teardown(scope);
    scope = null;
  });

  it("returns multiple selectable sessions and never auto-selects", () => {
    const { store } = scope!;
    const first = store.startSession({ agent_id: "bede", title: "First", harness: "hermes" });
    const second = store.startSession({ agent_id: "bede", title: "Second", harness: "hermes" });

    const result = store.listSessions({ agent_id: "bede" });

    expect(result.sessions.length).toBe(2);
    const ids = result.sessions.map((s) => s.id);
    expect(ids).toContain(first.session.id);
    expect(ids).toContain(second.session.id);
    expect((result as Record<string, unknown>).selected).toBeUndefined();
    expect((result as Record<string, unknown>).current).toBeUndefined();
  });

  it("ranks sessions matching the caller project_key first", () => {
    const { store } = scope!;
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

    expect(result.sessions[0].id).toBe(target.session.id);
    expect(result.sessions[1].id).toBe(other.session.id);
  });

  it("ranks source-matching sessions ahead of non-matching when project matches both", () => {
    const { store } = scope!;
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

    expect(result.sessions[0].id).toBe(sameProjSameSrc.session.id);
    expect(result.sessions[1].id).toBe(sameProjOtherSrc.session.id);
  });

  it("matches by source_ref as well as cwd when ranking source", () => {
    const { store } = scope!;
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

    expect(result.sessions[0].id).toBe(matchingSrc.session.id);
    expect(result.sessions[1].id).toBe(otherSrc.session.id);
  });

  it("hides agent_private sessions from other agents", () => {
    const { store } = scope!;
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
    expect(asBede).toContain(shared.session.id);
    expect(asBede).toContain(bedePrivate.session.id);
    expect(asBede).not.toContain(codexPrivate.session.id);

    const asCodex = store.listSessions({ agent_id: "codex" }).sessions.map((s) => s.id);
    expect(asCodex).toContain(shared.session.id);
    expect(asCodex).not.toContain(bedePrivate.session.id);
    expect(asCodex).toContain(codexPrivate.session.id);
  });

  it("admin override sees agent_private sessions from any agent", () => {
    const { store } = scope!;
    const codexPrivate = store.startSession({
      agent_id: "codex",
      title: "Codex private",
      harness: "codex",
      visibility: "agent_private",
    });

    const asAdmin = store.listSessions({ agent_id: "bede", admin: true }).sessions.map((s) => s.id);
    expect(asAdmin).toContain(codexPrivate.session.id);
  });

  it("honors limit", () => {
    const { store } = scope!;
    for (let i = 0; i < 5; i += 1) {
      store.startSession({ agent_id: "bede", title: `Session ${i}`, harness: "hermes" });
    }
    const result = store.listSessions({ agent_id: "bede", limit: 3 });
    expect(result.sessions.length).toBe(3);
    expect(result.total).toBe(5);
    expect(result.limit).toBe(3);
  });

  it("returns the most recently active session first when all ranking keys tie", async () => {
    const { store } = scope!;
    const first = store.startSession({ agent_id: "bede", title: "First", harness: "hermes" });
    await wait(5);
    const second = store.startSession({ agent_id: "bede", title: "Second", harness: "hermes" });
    await wait(5);
    const third = store.startSession({ agent_id: "bede", title: "Third", harness: "hermes" });

    const result = store.listSessions({ agent_id: "bede" });
    expect(result.sessions.map((s) => s.id)).toEqual([
      third.session.id,
      second.session.id,
      first.session.id,
    ]);
  });

  it("filters by harness when supplied", () => {
    const { store } = scope!;
    const onHermes = store.startSession({ agent_id: "bede", title: "Hermes", harness: "hermes" });
    store.startSession({ agent_id: "bede", title: "Codex", harness: "codex" });

    const result = store.listSessions({ agent_id: "bede", harness: "hermes" });
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0].id).toBe(onHermes.session.id);
  });
});

describe("LibrarianStore session events", () => {
  let scope: ScopedStore | null = null;

  beforeEach(() => {
    scope = makeScopedStore();
  });

  afterEach(() => {
    teardown(scope);
    scope = null;
  });

  it("recordSessionEvent appends a typed evidence event and bumps last_activity_at", async () => {
    const { store } = scope!;
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Recording",
      harness: "hermes",
    });
    const initialActivity = session.last_activity_at;

    await wait(5);

    const event = store.recordSessionEvent({
      agent_id: "bede",
      session_id: session.id,
      harness: "hermes",
      type: "decision",
      summary: "Use list-and-select rather than latest-inference.",
      payload: { confidence: "confirmed" },
    });

    expect(event.event_type).toBe("session.event_recorded");
    expect(event.session_id).toBe(session.id);
    expect(event.payload.type).toBe("decision");
    expect(event.payload.summary).toBe("Use list-and-select rather than latest-inference.");
    expect(event.payload.confidence).toBe("confirmed");

    const reloaded = store.getSession(session.id);
    expect(reloaded.last_activity_at > initialActivity).toBe(true);
    expect(reloaded.updated_at > initialActivity).toBe(true);
    expect(reloaded.status).toBe("active");
  });

  it("recordSessionEvent rejects unknown payload types", () => {
    const { store } = scope!;
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Reject",
      harness: "hermes",
    });
    expect(() =>
      store.recordSessionEvent({
        agent_id: "bede",
        session_id: session.id,
        type: "garbage",
        summary: "x",
      }),
    ).toThrow(/payload type/i);
  });

  it("recordSessionEvent throws for unknown session_id", () => {
    const { store } = scope!;
    expect(() =>
      store.recordSessionEvent({
        agent_id: "bede",
        session_id: "ses_nope",
        type: "note",
        summary: "x",
      }),
    ).toThrow(/session/i);
  });

  it("listSessionEvents returns events with pagination and type filter", () => {
    const { store } = scope!;
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
    expect(all.total).toBe(5);
    expect(all.events.length).toBe(5);

    const decisions = store.listSessionEvents({ session_id: session.id, type: "decision" });
    expect(decisions.total).toBe(2);
    expect(decisions.events.every((event) => event.type === "decision")).toBe(true);

    const paginated = store.listSessionEvents({ session_id: session.id, limit: 2, offset: 1 });
    expect(paginated.events.length).toBe(2);
    expect(paginated.limit).toBe(2);
    expect(paginated.offset).toBe(1);
    expect(paginated.total).toBe(5);
  });

  it("listSessionEvents returns events in chronological order (oldest first)", async () => {
    const { store } = scope!;
    const { session } = store.startSession({ agent_id: "bede", title: "Order", harness: "hermes" });
    await wait(2);
    store.recordSessionEvent({
      agent_id: "bede",
      session_id: session.id,
      type: "note",
      summary: "first",
    });
    await wait(2);
    store.recordSessionEvent({
      agent_id: "bede",
      session_id: session.id,
      type: "note",
      summary: "second",
    });

    const result = store.listSessionEvents({ session_id: session.id, type: "note" });
    expect(result.events[0].summary).toBe("first");
    expect(result.events[1].summary).toBe("second");
  });

  it("listSessionEvents returns empty for unknown session_id", () => {
    const { store } = scope!;
    const result = store.listSessionEvents({ session_id: "ses_nope" });
    expect(result.events).toEqual([]);
    expect(result.total).toBe(0);
  });
});

describe("LibrarianStore checkpoint / pause / end", () => {
  let scope: ScopedStore | null = null;

  beforeEach(() => {
    scope = makeScopedStore();
  });

  afterEach(() => {
    teardown(scope);
    scope = null;
  });

  it("checkpointSession overwrites rolling_summary and keeps the session active", () => {
    const { store } = scope!;
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

    expect(result.session.status).toBe("active");
    expect(result.session.rolling_summary).toBe("Formalised the session model.");
    expect(result.session.next_steps).toEqual(["Implement session event projection"]);

    store.checkpointSession({
      agent_id: "bede",
      session_id: session.id,
      summary: "Newer snapshot.",
    });
    expect(store.getSession(session.id).rolling_summary).toBe("Newer snapshot.");
  });

  it("pauseSession marks the session paused, updates rolling_summary, and sets paused_at", () => {
    const { store } = scope!;
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

    expect(result.session.status).toBe("paused");
    expect(result.session.rolling_summary).toBe("Stepping away.");
    expect(result.session.paused_at).toBeTruthy();
  });

  it("recording an event on a paused session implicitly resumes it", () => {
    const { store } = scope!;
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Implicit resume",
      harness: "hermes",
    });
    store.pauseSession({ agent_id: "bede", session_id: session.id, summary: "Pause." });
    expect(store.getSession(session.id).status).toBe("paused");

    store.recordSessionEvent({
      agent_id: "bede",
      session_id: session.id,
      type: "note",
      summary: "Back at it.",
    });

    const reloaded = store.getSession(session.id);
    expect(reloaded.status).toBe("active");
    expect(reloaded.paused_at).toBeNull();
  });

  it("checkpointing a paused session implicitly resumes it", () => {
    const { store } = scope!;
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
    expect(reloaded.status).toBe("active");
    expect(reloaded.paused_at).toBeNull();
    expect(reloaded.rolling_summary).toBe("Picking back up.");
  });

  it("endSession writes end_summary, freezes rolling_summary, and marks the session ended", () => {
    const { store } = scope!;
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

    expect(result.session.status).toBe("ended");
    expect(result.session.end_summary).toBe("All done.");
    expect(result.session.rolling_summary).toBe("Midway snapshot.");
    expect(result.session.next_steps).toEqual(["Open the PR"]);
    expect(result.session.ended_at).toBeTruthy();
  });

  it("ended sessions hide from default list but recording an event resumes them", () => {
    // S1.1: ended is the soft-hide state. The lifecycle gate accepts ended
    // for record/attach/continue and flips status back to active or paused.
    const { store } = scope!;
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Sealed",
      harness: "hermes",
    });
    store.endSession({ agent_id: "bede", session_id: session.id, summary: "Done." });

    // Hidden by default
    expect(store.listSessions({ agent_id: "bede" }).sessions.length).toBe(0);
    // Opt back in
    expect(store.listSessions({ agent_id: "bede", include_ended: true }).sessions.length).toBe(1);

    // Recording an event resumes the session
    store.recordSessionEvent({
      agent_id: "bede",
      session_id: session.id,
      type: "note",
      summary: "Picked it back up.",
    });
    expect(store.getSession(session.id).status).toBe("active");
  });
});

describe("LibrarianStore attach / continue", () => {
  let scope: ScopedStore | null = null;

  beforeEach(() => {
    scope = makeScopedStore();
  });

  afterEach(() => {
    teardown(scope);
    scope = null;
  });

  it("attachSession overwrites current_harness/current_agent_id/source_ref/cwd and appends an event", () => {
    const { store } = scope!;
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

    expect(result.session.current_agent_id).toBe("codex");
    expect(result.session.current_harness).toBe("codex");
    expect(result.session.source_ref).toBe("codex:run:r1:cwd:/new/path");
    expect(result.session.cwd).toBe("/new/path");
    expect(result.session.created_by_agent_id).toBe("bede");
    expect(result.session.created_in_harness).toBe("hermes");

    const events = store.listSessionEvents({ session_id: session.id });
    expect(events.events.some((event) => event.type === "attached_to_harness")).toBe(true);
  });

  it("attachSession works on ended sessions and resumes the lifecycle", () => {
    // S1.1: ended is no longer a terminal state — attach + record_event
    // resume work seamlessly.
    const { store } = scope!;
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Sealed but pickable",
      harness: "hermes",
    });
    store.endSession({ agent_id: "bede", session_id: session.id, summary: "Done." });
    const attached = store.attachSession({
      session_id: session.id,
      agent_id: "codex",
      harness: "codex",
    });
    expect(attached.session.current_harness).toBe("codex");
  });

  it("continueSession returns a handover with original and current harness/source, plus aggregated decisions", () => {
    const { store } = scope!;
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

    expect(result.session.current_harness).toBe("codex");
    expect(result.session.current_agent_id).toBe("codex");
    expect(result.session.cwd).toBe("/dev");
    expect(result.session.source_ref).toBe("codex:run:r1:cwd:/dev");

    expect(result.handover.title).toBe("Handover content");
    expect(result.handover.project_key).toBe("the-librarian");
    expect(result.handover.created_in_harness).toBe("hermes");
    expect(result.handover.created_source_ref).toBe("discord:channel:1:thread:2");
    expect(result.handover.current_harness).toBe("codex");
    expect(result.handover.current_source_ref).toBe("codex:run:r1:cwd:/dev");
    expect(result.handover.start_summary).toBe("Designing the session layer.");
    expect(result.handover.rolling_summary).toBe("Drafted handover behaviour.");
    expect(result.handover.next_steps).toEqual(["Add tests for restore"]);
    expect(result.handover.decisions).toContain("Default attach=true");
    expect(result.handover.decisions).toContain("Use prose as default format");
    expect(result.handover.files_touched).toContain("src/store.js");
    expect(result.handover.commands_run).toContain("npm test");

    expect(result.text).toContain("Handover content");
    expect(result.text).toContain("codex");
  });

  it("continueSession with attach=false leaves current_harness untouched", () => {
    const { store } = scope!;
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

    expect(result.session.current_harness).toBe("hermes");
    expect(result.session.current_agent_id).toBe("bede");
    expect(result.session.source_ref).toBe("discord:1:2");
    expect(result.handover.current_harness).toBe("hermes");
  });

  it("continueSession does not append an attach event when target matches current", () => {
    const { store } = scope!;
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
    expect(after).toBe(before);
  });

  it("continueSession with format=markdown renders the spec's handover sections", () => {
    const { store } = scope!;
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

    expect(result.text).toContain("# Librarian Session Handover");
    expect(result.text).toContain("Markdown render");
    expect(result.text).toContain("## Decisions");
    expect(result.text).toContain("Decision A");
    expect(result.text).toContain("src/store.js");
    expect(result.text).toContain("npm test");
    expect(result.text).toContain("Q1?");
    expect(result.text).toContain("Next A");
  });

  it("continueSession on an ended session works with attach=true and resumes the lifecycle", () => {
    // S1.1: ended → continue(attach=true) is the resume path. attach=false
    // still works as a handover preview.
    const { store } = scope!;
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
    expect(preview.handover.status).toBe("ended");

    const attached = store.continueSession({
      agent_id: "codex",
      session_id: session.id,
      target_harness: "codex",
      attach: true,
    });
    expect(attached.session.current_harness).toBe("codex");
  });
});

describe("LibrarianStore searchSessions", () => {
  let scope: ScopedStore | null = null;

  beforeEach(() => {
    scope = makeScopedStore();
  });

  afterEach(() => {
    teardown(scope);
    scope = null;
  });

  it("finds sessions whose event summaries contain matching tokens", () => {
    const { store } = scope!;
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
    expect(ids).toContain(target.id);
    expect(ids.length).toBe(1);
  });

  it("finds sessions by checkpoint summary content", () => {
    const { store } = scope!;
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
    expect(result.sessions.some((s) => s.id === session.id)).toBe(true);
  });

  it("excludes ended sessions by default and shows them with include_ended", () => {
    // S1.1: ended is the soft-hide state for search too. The legacy
    // include_archived / include_deleted aliases still surface ended
    // results for backward compatibility.
    const { store } = scope!;
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Findable ended",
      harness: "hermes",
      start_summary: "Investigate BM25 recall.",
    });
    store.endSession({ agent_id: "bede", session_id: session.id, summary: "Wrapped." });

    const def = store.searchSessions({ agent_id: "bede", query: "BM25" });
    expect(def.sessions.length).toBe(0);

    const inc = store.searchSessions({ agent_id: "bede", query: "BM25", include_ended: true });
    expect(inc.sessions.length).toBe(1);

    // Legacy alias still works.
    const legacy = store.searchSessions({
      agent_id: "bede",
      query: "BM25",
      include_archived: true,
    });
    expect(legacy.sessions.length).toBe(1);
  });

  it("hides agent_private sessions belonging to other agents", () => {
    const { store } = scope!;
    const { session: priv } = store.startSession({
      agent_id: "codex",
      title: "Codex priv",
      harness: "codex",
      visibility: "agent_private",
      start_summary: "Investigate BM25 recall.",
    });

    const asBede = store.searchSessions({ agent_id: "bede", query: "BM25" });
    expect(asBede.sessions.length).toBe(0);

    const asCodex = store.searchSessions({ agent_id: "codex", query: "BM25" });
    expect(asCodex.sessions.length).toBe(1);
    expect(asCodex.sessions[0].id).toBe(priv.id);
  });

  it("filters by project_key when supplied", () => {
    const { store } = scope!;
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
    expect(alpha.sessions.length).toBe(1);
    expect(alpha.sessions[0].project_key).toBe("alpha");
  });

  it("returns an empty result for a blank query", () => {
    const { store } = scope!;
    store.startSession({ agent_id: "bede", title: "Test", harness: "hermes" });
    const result = store.searchSessions({ agent_id: "bede", query: "" });
    expect(result.sessions.length).toBe(0);
    expect(result.total).toBe(0);
  });
});

describe("LibrarianStore promoteSessionFact", () => {
  let scope: ScopedStore | null = null;

  beforeEach(() => {
    scope = makeScopedStore();
  });

  afterEach(() => {
    teardown(scope);
    scope = null;
  });

  it("creates an active memory for non-protected categories and records the link", () => {
    const { store } = scope!;
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

    expect(result.status).toBe("active");
    expect(result.memory.status).toBe("active");
    expect(result.memory.title).toBe("Use lib: prefix for session commands");
    expect(result.session_id).toBe(session.id);

    const events = store.listSessionEvents({ session_id: session.id });
    const promo = events.events.find((event) => event.type === "promoted_to_memory");
    expect(promo).toBeTruthy();
    expect(promo!.payload.memory_id).toBe(result.memory.id);
  });

  it("routes protected categories through the proposal flow", () => {
    const { store } = scope!;
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

    expect(result.status).toBe("proposed");
    expect(result.memory.status).toBe("proposed");
  });

  it("stores session_event_id on the promotion event when supplied", () => {
    const { store } = scope!;
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

    expect(result.session_event_id).toBe(decision.event_id);
    const events = store.listSessionEvents({ session_id: session.id });
    const promo = events.events.find((event) => event.type === "promoted_to_memory");
    expect(promo!.payload.session_event_id).toBe(decision.event_id);
  });

  it("throws for unknown session_id", () => {
    const { store } = scope!;
    expect(() =>
      store.promoteSessionFact({
        agent_id: "bede",
        session_id: "ses_nope",
        memory: { title: "x", body: "x", category: "tools" },
      }),
    ).toThrow(/session/i);
  });

  it("does not create the memory when the input lacks both title and body", () => {
    const { store } = scope!;
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Empty input",
      harness: "hermes",
    });
    expect(() =>
      store.promoteSessionFact({
        agent_id: "bede",
        session_id: session.id,
        memory: { category: "tools" },
      }),
    ).toThrow(/title|body|memory/i);
  });
});
