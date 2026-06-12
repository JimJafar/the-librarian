// Slice-scoped memory evidence gathering for the curator (spec §9).
//
// The two load-bearing guards here are SECURITY guards and are tested first:
//   1. Slice isolation — a common_project run sees only that project's memories;
//      common_global only project-less ones (slices are project-key-only,
//      rethink D8). A curation run must never read across a slice boundary
//      (§3, §9).
//   2. Redaction-before-return — secret-looking material is scrubbed from
//      evidence BEFORE it can be handed to the prompt builder (§9, §10.4); by
//      output-validation time the value would already have left the building.
//
// Tombstones carry metadata + a content fingerprint (no body) for the §10.3
// resurrection pre-pass. Caps + truncation keep the bundle bounded (§9 caps).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  createLibrarianStore,
  createVaultGroomingMemorySource,
  gatherMemoryEvidence,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Scope {
  store: LibrarianStore;
  dataDir: string;
}

let s: Scope | null = null;

beforeEach(() => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-evidence-"));
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

/** Seed a memory; defaults to a common/project-x active "lessons" memory. */
function seed(overrides: Record<string, unknown> = {}) {
  return s!.store.createMemory({
    agent_id: "agent-a",
    title: "title",
    body: "body text",
    category: "lessons",
    visibility: "common",
    scope: "project",
    project_key: "proj-x",
    priority: "normal",
    confidence: "working",
    ...overrides,
  });
}

describe("gatherMemoryEvidence — slice isolation (Section 4d.3 — visibility-based privacy retired)", () => {
  it("common_project returns memories scoped to that project key", () => {
    const here = seed({ title: "here", project_key: "proj-x" }).memory;
    seed({ title: "other-project", project_key: "proj-y" });

    const bundle = gatherMemoryEvidence(
      createVaultGroomingMemorySource(s!.store),
      { kind: "common_project", projectKey: "proj-x" },
      { maxMemories: 50 },
    );

    expect(bundle.activeMemories.map((m) => m.id)).toEqual([here.id]);
    for (const m of bundle.activeMemories) {
      expect(m.projectKey).toBe("proj-x");
    }
  });

  it("common_global returns memories with no project_key", () => {
    const global = seed({ title: "global", project_key: undefined }).memory;
    seed({ title: "project-scoped", project_key: "proj-x" });

    const bundle = gatherMemoryEvidence(
      createVaultGroomingMemorySource(s!.store),
      { kind: "common_global" },
      { maxMemories: 50 },
    );

    expect(bundle.activeMemories.map((m) => m.id)).toContain(global.id);
  });

  it("partitions on project_key — a memory with a project_key is NOT in the global slice", () => {
    const globalNoProject = seed({ title: "g", project_key: undefined }).memory;
    const globalButKeyed = seed({ title: "gp", project_key: "proj-x" }).memory;

    const inGlobal = gatherMemoryEvidence(
      createVaultGroomingMemorySource(s!.store),
      { kind: "common_global" },
      { maxMemories: 50 },
    ).activeMemories.map((m) => m.id);
    const inProject = gatherMemoryEvidence(
      createVaultGroomingMemorySource(s!.store),
      { kind: "common_project", projectKey: "proj-x" },
      { maxMemories: 50 },
    ).activeMemories.map((m) => m.id);

    expect(inGlobal).toContain(globalNoProject.id);
    expect(inGlobal).not.toContain(globalButKeyed.id);
    expect(inProject).toContain(globalButKeyed.id);
    expect(inProject).not.toContain(globalNoProject.id);
  });

  it("keeps an agent-authored common memory in the common slice (post-cutover, agent_id no longer privatises)", () => {
    const m = seed({
      title: "common-by-agent",
      agent_id: "agent-z",
      project_key: "proj-x",
    }).memory;
    const bundle = gatherMemoryEvidence(
      createVaultGroomingMemorySource(s!.store),
      { kind: "common_project", projectKey: "proj-x" },
      { maxMemories: 50 },
    );
    expect(bundle.activeMemories.map((x) => x.id)).toContain(m.id);
  });
});

describe("gatherMemoryEvidence — redaction (security)", () => {
  it("redacts secret-looking material from bodies before returning", () => {
    seed({ title: "with-secret", body: 'deploy notes — token = "FAKETOKENFAKETOKEN" — ok' });

    const bundle = gatherMemoryEvidence(
      createVaultGroomingMemorySource(s!.store),
      { kind: "common_project", projectKey: "proj-x" },
      { maxMemories: 50 },
    );

    const body = bundle.activeMemories[0]!.body;
    expect(body).not.toContain("FAKETOKENFAKETOKEN");
    expect(body).toContain("[REDACTED:secret]");
    expect(bundle.redactionCount).toBeGreaterThan(0);
  });
});

describe("gatherMemoryEvidence — status partition + tombstones", () => {
  it("splits active and proposed memories", () => {
    const active = seed({ title: "active-one", category: "lessons" }).memory;
    // Section 4d.3 — the legacy category-based gate is gone. The
    // curator's apply layer (and direct callers) opt in to the
    // proposal flow via `options.requires_approval: true`.
    const proposed = s!.store.createMemory(
      {
        agent_id: "agent-a",
        title: "proposed-one",
        body: "body text",
        category: "identity",
        visibility: "common",
        scope: "project",
        project_key: "proj-x",
        priority: "normal",
        confidence: "working",
      },
      { requires_approval: true },
    ).memory;

    const bundle = gatherMemoryEvidence(
      createVaultGroomingMemorySource(s!.store),
      { kind: "common_project", projectKey: "proj-x" },
      { maxMemories: 50 },
    );

    expect(bundle.activeMemories.map((m) => m.id)).toContain(active.id);
    expect(bundle.activeMemories.every((m) => m.status === "active")).toBe(true);
    expect(bundle.proposedMemories.map((m) => m.id)).toContain(proposed.id);
    expect(bundle.proposedMemories.every((m) => m.status === "proposed")).toBe(true);
  });

  it("returns archived memories as metadata-only tombstones with a fingerprint and no body", () => {
    const m = seed({ title: "deleted thing", body: "the original body" }).memory;
    s!.store.archiveMemory(m.id);

    const bundle = gatherMemoryEvidence(
      createVaultGroomingMemorySource(s!.store),
      { kind: "common_project", projectKey: "proj-x" },
      { maxMemories: 50 },
    );

    expect(bundle.activeMemories.map((x) => x.id)).not.toContain(m.id);
    const tomb = bundle.tombstones.find((t) => t.id === m.id);
    expect(tomb).toBeDefined();
    expect(tomb!.contentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(tomb!.normalizedTitle).toContain("deleted thing");
    expect(typeof tomb!.archivedAt).toBe("string");
    // The deleted body must NOT be re-exposed.
    expect((tomb as unknown as Record<string, unknown>).body).toBeUndefined();
    expect(JSON.stringify(tomb)).not.toContain("the original body");
  });

  it("reports a null reason for a plain archive (none recorded at source)", () => {
    const m = seed({ title: "plain-archive", body: "x" }).memory;
    s!.store.archiveMemory(m.id);

    const bundle = gatherMemoryEvidence(
      createVaultGroomingMemorySource(s!.store),
      { kind: "common_project", projectKey: "proj-x" },
      { maxMemories: 50 },
    );
    expect(bundle.tombstones.find((t) => t.id === m.id)?.archiveReason).toBeNull();
  });
});

describe("gatherMemoryEvidence — caps + truncation", () => {
  it("caps the combined memory budget, prioritising active over proposed", () => {
    seed({ title: "a1", category: "lessons" });
    seed({ title: "a2", category: "lessons" });
    seed({ title: "a3", category: "lessons" });
    seed({ title: "p1", category: "identity" }); // proposed

    const bundle = gatherMemoryEvidence(
      createVaultGroomingMemorySource(s!.store),
      { kind: "common_project", projectKey: "proj-x" },
      { maxMemories: 2 },
    );

    expect(bundle.activeMemories).toHaveLength(2);
    expect(bundle.proposedMemories).toHaveLength(0);
    expect(bundle.truncatedMemories).toBe(true);
  });

  it("truncates an oversized body with a marker and flags it", () => {
    seed({ title: "long", body: "abcdefghijklmnopqrstuvwxyz" });

    const bundle = gatherMemoryEvidence(
      createVaultGroomingMemorySource(s!.store),
      { kind: "common_project", projectKey: "proj-x" },
      { maxMemories: 50, maxBodyChars: 10 },
    );

    const body = bundle.activeMemories[0]!.body;
    expect(body.startsWith("abcdefghij")).toBe(true);
    expect(body).not.toBe("abcdefghijklmnopqrstuvwxyz");
    expect(body).toMatch(/truncated/i);
    expect(bundle.truncatedFields).toBe(true);
  });
});

describe("gatherMemoryEvidence — slice descriptor validation", () => {
  it("rejects common_project without a projectKey", () => {
    expect(() =>
      gatherMemoryEvidence(
        createVaultGroomingMemorySource(s!.store),
        { kind: "common_project" },
        { maxMemories: 5 },
      ),
    ).toThrow(/projectKey/i);
  });
});

describe("gatherMemoryEvidence — open curator flag surfacing (review F2)", () => {
  it("surfaces has_open_curator_flag: true only when the curator actor holds an open flag", () => {
    const flagged = seed({ title: "flagged" }).memory;
    const otherAgent = seed({ title: "agent-flagged" }).memory;
    const clean = seed({ title: "clean" }).memory;
    s!.store.flagMemory(flagged.id, "curator proposes archive: dup", "system-memory-curator");
    s!.store.flagMemory(otherAgent.id, "looks outdated", "codex");

    const items = gatherMemoryEvidence(
      createVaultGroomingMemorySource(s!.store),
      { kind: "common_project", projectKey: "proj-x" },
      { maxMemories: 50 },
    ).activeMemories;
    const byId = new Map(items.map((m) => [m.id, m]));

    expect(byId.get(flagged.id)?.has_open_curator_flag).toBe(true);
    // Omitted (not false) when absent — the evidence JSON stays lean and the
    // prompt only ever sees the marker on genuinely curator-flagged memories.
    expect("has_open_curator_flag" in byId.get(otherAgent.id)!).toBe(false);
    expect("has_open_curator_flag" in byId.get(clean.id)!).toBe(false);
  });

  it("an admin-resolved flag no longer marks the memory (resolved flags are not open)", () => {
    const m = seed({ title: "resolved" }).memory;
    s!.store.flagMemory(m.id, "curator proposes archive: dup", "system-memory-curator");
    s!.store.resolveFlags(m.id, "dashboard-admin");

    const items = gatherMemoryEvidence(
      createVaultGroomingMemorySource(s!.store),
      { kind: "common_project", projectKey: "proj-x" },
      { maxMemories: 50 },
    ).activeMemories;
    expect("has_open_curator_flag" in items.find((i) => i.id === m.id)!).toBe(false);
  });
});
