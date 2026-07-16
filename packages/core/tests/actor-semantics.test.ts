// Actor semantics — trailer eligibility + the ActorKind→channel table (spec 064 T5 / SC 5, SC 6).
//
// These are the two pure decisions the substrate makes about an actor, stated
// exhaustively so 061's deliberate attribution choices are never silently reversed:
//   1. WHICH actors get a `Librarian-Actor` trailer (actorTrailerValue) — the axiom
//      is "a false name is worse than an honest null".
//   2. WHICH channel a TRAILERED commit reports (channelForActor) — derived from the
//      actor's kind, never from the commit subject.
// The export (T6) consumes both to fill AuditEvent.actor / AuditEvent.channel; here we
// pin the mechanisms directly.

import { actorTrailerValue, channelForActor, classifyVaultCommit } from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("trailer eligibility (spec 064 SC 5 / SC 7b)", () => {
  it("trailers the sentinels — 061's deliberate attribution actors for the OSS default", () => {
    // env-token-agent / local-agent ARE the resolved principal of the default install; refusing
    // them a trailer would make the export LESS attributable than the frontmatter already is.
    expect(actorTrailerValue("local-agent")).toBe("local-agent");
    expect(actorTrailerValue("env-token-agent")).toBe("env-token-agent");
  });

  it("trailers the system pipelines and dashboard/admin", () => {
    expect(actorTrailerValue("system-consolidator")).toBe("system-consolidator");
    expect(actorTrailerValue("system-memory-curator")).toBe("system-memory-curator");
    expect(actorTrailerValue("dashboard-admin")).toBe("dashboard-admin");
    expect(actorTrailerValue("claude-code")).toBe("claude-code");
  });

  it("does NOT trailer unknown-agent (the absence of an actor) or a blank/undefined id", () => {
    expect(actorTrailerValue("unknown-agent")).toBeUndefined();
    expect(actorTrailerValue("")).toBeUndefined();
    expect(actorTrailerValue(undefined)).toBeUndefined();
  });

  it("drops a non-canonical id rather than mangle it (a false name is worse than a null)", () => {
    expect(actorTrailerValue("alice\nLibrarian-Actor: root")).toBeUndefined();
    expect(actorTrailerValue("Alice")).toBeUndefined(); // uppercase is not canonical
    expect(actorTrailerValue(" local-agent ")).toBeUndefined(); // surrounding whitespace
    expect(actorTrailerValue("member:sarah")).toBeUndefined(); // colon is not canonical
  });
});

describe("ActorKind → channel table (spec 064 SC 5 / SC 6)", () => {
  it("maps each kind exactly as the table states", () => {
    // agent (incl. the sentinels)
    expect(channelForActor("local-agent")).toBe("agent");
    expect(channelForActor("env-token-agent")).toBe("agent");
    expect(channelForActor("claude-code")).toBe("agent");
    // system pipelines
    expect(channelForActor("system-consolidator")).toBe("system");
    expect(channelForActor("system-memory-curator")).toBe("system");
    // admin, and cli (the operator acting locally)
    expect(channelForActor("dashboard-admin")).toBe("admin");
    expect(channelForActor("cli")).toBe("admin");
  });

  it("fixes the dashboard-edit misclassification (SC 6): actor-derived channel is admin, not curator", () => {
    // The subject-based legacy classifier still calls a dashboard memory edit "curator" (the
    // memory-lifecycle arm) — that is DELIBERATELY unchanged for the activity feed.
    expect(classifyVaultCommit("memory: update mem_1")).toBe("curator");
    // But a dashboard edit is TRAILERED `dashboard-admin`, so the export derives its channel
    // from the actor → "admin". The two disagree ON PURPOSE (spec 064 SC 6/SC 7d).
    expect(channelForActor("dashboard-admin")).toBe("admin");
  });
});
