// Slice-scoped session evidence gathering for the curator (spec §9).
//
// Mirrors memory evidence: same slice-isolation guard (a run never reads across
// a slice boundary, §3) and the same redaction-before-return guard (§9/§10.4),
// applied to sessions + their typed evidence events. The agent_private slice is
// keyed on the session's OWNER (created_by_agent_id). Lifecycle noise
// (started/paused/checkpointed/ended) is excluded — only the typed evidence
// events (decisions, commands, files, notes, …) are gathered, decisions first.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LibrarianStore, createLibrarianStore, gatherSessionEvidence } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Scope {
  store: LibrarianStore;
  dataDir: string;
}

let s: Scope | null = null;

beforeEach(() => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-sess-evidence-"));
  s = { store: createLibrarianStore({ dataDir }), dataDir };
});
afterEach(() => {
  if (!s) return;
  try {
    s.store.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(s.dataDir, { recursive: true, force: true });
  s = null;
});

/** Start a session; defaults to a common/project-x session owned by agent-a. */
function startSess(overrides: Record<string, unknown> = {}) {
  const { session } = s!.store.startSession({
    title: "a session",
    project_key: "proj-x",
    agent_id: "agent-a",
    visibility: "common",
    ...overrides,
  });
  return session!;
}

function record(sessionId: string, type: string, summary: string) {
  return s!.store.recordSessionEvent({ session_id: sessionId, type, summary });
}

describe("gatherSessionEvidence — slice isolation (security)", () => {
  it("common_project returns only that project's common sessions", () => {
    const here = startSess({ project_key: "proj-x" });
    startSess({ project_key: "proj-y" });
    startSess({ visibility: "agent_private", project_key: undefined });

    const bundle = gatherSessionEvidence(
      s!.store.db,
      { kind: "common_project", projectKey: "proj-x" },
      { maxSessions: 50 },
    );

    expect(bundle.sessions.map((x) => x.id)).toEqual([here.id]);
  });

  it("agent_private returns only the owning agent's private sessions", () => {
    const mine = startSess({
      visibility: "agent_private",
      agent_id: "agent-a",
      project_key: undefined,
    });
    startSess({ visibility: "agent_private", agent_id: "agent-b", project_key: undefined });
    startSess({ visibility: "common", project_key: "proj-x" });

    const bundle = gatherSessionEvidence(
      s!.store.db,
      { kind: "agent_private", agentId: "agent-a" },
      { maxSessions: 50 },
    );

    expect(bundle.sessions.map((x) => x.id)).toEqual([mine.id]);
    for (const sess of bundle.sessions) {
      expect(sess.createdByAgentId).toBe("agent-a");
    }
  });

  it("common_global returns only project-less common sessions", () => {
    const global = startSess({ project_key: undefined });
    startSess({ project_key: "proj-x" });
    startSess({ visibility: "agent_private", project_key: undefined });

    const bundle = gatherSessionEvidence(
      s!.store.db,
      { kind: "common_global" },
      { maxSessions: 50 },
    );

    expect(bundle.sessions.map((x) => x.id)).toEqual([global.id]);
  });

  it("keeps a handed-over private session in its CREATOR's slice, not the current holder's", () => {
    // Created by agent-a, handed over to agent-b. The content originated under
    // agent-a's privacy boundary, so it must stay in agent-a's run and never
    // surface in agent-b's — keying on created_by_agent_id fails closed.
    const sess = startSess({
      visibility: "agent_private",
      agent_id: "agent-a",
      project_key: undefined,
    });
    s!.store.attachSession({ session_id: sess.id, agent_id: "agent-b" });

    const owner = gatherSessionEvidence(
      s!.store.db,
      { kind: "agent_private", agentId: "agent-a" },
      { maxSessions: 50 },
    );
    const holder = gatherSessionEvidence(
      s!.store.db,
      { kind: "agent_private", agentId: "agent-b" },
      { maxSessions: 50 },
    );

    expect(owner.sessions.map((x) => x.id)).toContain(sess.id);
    expect(holder.sessions.map((x) => x.id)).not.toContain(sess.id);
  });
});

describe("gatherSessionEvidence — events", () => {
  it("gathers typed evidence events, prioritising decisions, and excludes lifecycle noise", () => {
    const sess = startSess();
    record(sess.id, "message", "just chatting");
    record(sess.id, "decision", "chose approach X");

    const bundle = gatherSessionEvidence(
      s!.store.db,
      { kind: "common_project", projectKey: "proj-x" },
      { maxSessions: 50 },
    );

    const events = bundle.sessions[0]!.events;
    expect(events[0]!.type).toBe("decision"); // decisions first regardless of recency
    expect(events.map((e) => e.type)).toContain("message");
    // The session.started lifecycle event must not appear as evidence.
    expect(events.map((e) => e.type)).not.toContain("started");
  });

  it("surfaces session summaries and next steps", () => {
    const sess = startSess({ start_summary: "kicked off the work", next_steps: ["do the thing"] });

    const bundle = gatherSessionEvidence(
      s!.store.db,
      { kind: "common_project", projectKey: "proj-x" },
      { maxSessions: 50 },
    );

    const item = bundle.sessions.find((x) => x.id === sess.id)!;
    expect(item.startSummary).toBe("kicked off the work");
    expect(item.nextSteps).toContain("do the thing");
  });

  it("tolerates malformed next_steps_json without throwing", () => {
    const sess = startSess();
    // Simulate projection corruption: a non-JSON next_steps_json value.
    s!.store.db
      .prepare("UPDATE sessions SET next_steps_json = ? WHERE id = ?")
      .run("{not valid json", sess.id);

    const bundle = gatherSessionEvidence(
      s!.store.db,
      { kind: "common_project", projectKey: "proj-x" },
      { maxSessions: 50 },
    );

    expect(bundle.sessions.find((x) => x.id === sess.id)!.nextSteps).toEqual([]);
  });
});

describe("gatherSessionEvidence — redaction (security)", () => {
  it("redacts secrets from summaries and event text before returning", () => {
    const sess = startSess({ start_summary: 'set token = "FAKESTARTSECRET" in env' });
    record(sess.id, "command", 'ran with password = "FAKECMDSECRET"');

    const bundle = gatherSessionEvidence(
      s!.store.db,
      { kind: "common_project", projectKey: "proj-x" },
      { maxSessions: 50 },
    );

    const item = bundle.sessions.find((x) => x.id === sess.id)!;
    const serialized = JSON.stringify(item);
    expect(serialized).not.toContain("FAKESTARTSECRET");
    expect(serialized).not.toContain("FAKECMDSECRET");
    expect(item.startSummary).toContain("[REDACTED:secret]");
    expect(bundle.redactionCount).toBeGreaterThan(0);
  });
});

describe("gatherSessionEvidence — caps", () => {
  it("caps the number of sessions and flags truncation", () => {
    startSess({ title: "s1" });
    startSess({ title: "s2" });
    startSess({ title: "s3" });

    const bundle = gatherSessionEvidence(
      s!.store.db,
      { kind: "common_project", projectKey: "proj-x" },
      { maxSessions: 2 },
    );

    expect(bundle.sessions).toHaveLength(2);
    expect(bundle.truncatedSessions).toBe(true);
  });

  it("caps events per session and flags per-session truncation", () => {
    const sess = startSess();
    record(sess.id, "note", "n1");
    record(sess.id, "note", "n2");
    record(sess.id, "note", "n3");

    const bundle = gatherSessionEvidence(
      s!.store.db,
      { kind: "common_project", projectKey: "proj-x" },
      { maxSessions: 50, maxEventsPerSession: 2 },
    );

    const item = bundle.sessions.find((x) => x.id === sess.id)!;
    expect(item.events).toHaveLength(2);
    expect(item.truncatedEvents).toBe(true);
  });
});

describe("gatherSessionEvidence — slice descriptor validation", () => {
  it("rejects common_project without a projectKey", () => {
    expect(() =>
      gatherSessionEvidence(s!.store.db, { kind: "common_project" }, { maxSessions: 5 }),
    ).toThrow(/projectKey/i);
  });

  it("rejects agent_private without an agentId", () => {
    expect(() =>
      gatherSessionEvidence(s!.store.db, { kind: "agent_private" }, { maxSessions: 5 }),
    ).toThrow(/agentId/i);
  });
});
