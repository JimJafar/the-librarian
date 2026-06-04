// Slice-scoped memory evidence gathering for the curator (spec §9).
//
// The two load-bearing guards here are SECURITY guards and are tested first:
//   1. Slice isolation — an agent_private run sees only that agent's private
//      memories; a common_project run sees only that project's common memories.
//      A curation run must never read across a slice boundary (§3, §9).
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
  createVaultCuratorMemorySource,
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
      createVaultCuratorMemorySource(s!.store),
      { kind: "common_project", projectKey: "proj-x" },
      { maxMemories: 50 },
    );

    expect(bundle.activeMemories.map((m) => m.id)).toEqual([here.id]);
    for (const m of bundle.activeMemories) {
      expect(m.projectKey).toBe("proj-x");
    }
  });

  it("agent_private returns memories authored by the named agent (now author-scoped, not visibility-scoped)", () => {
    const mine = seed({
      title: "mine",
      agent_id: "agent-a",
      project_key: undefined,
    }).memory;
    seed({ title: "theirs", agent_id: "agent-b", project_key: undefined });

    const bundle = gatherMemoryEvidence(
      createVaultCuratorMemorySource(s!.store),
      { kind: "agent_private", agentId: "agent-a" },
      { maxMemories: 50 },
    );

    expect(bundle.activeMemories.map((m) => m.id)).toContain(mine.id);
    for (const m of bundle.activeMemories) {
      expect(m.agentId).toBe("agent-a");
    }
  });

  it("common_global returns memories with no project_key", () => {
    const global = seed({ title: "global", project_key: undefined }).memory;
    seed({ title: "project-scoped", project_key: "proj-x" });

    const bundle = gatherMemoryEvidence(
      createVaultCuratorMemorySource(s!.store),
      { kind: "common_global" },
      { maxMemories: 50 },
    );

    expect(bundle.activeMemories.map((m) => m.id)).toContain(global.id);
  });

  it("partitions on project_key — a memory with a project_key is NOT in the global slice", () => {
    const globalNoProject = seed({ title: "g", project_key: undefined }).memory;
    const globalButKeyed = seed({ title: "gp", project_key: "proj-x" }).memory;

    const inGlobal = gatherMemoryEvidence(
      createVaultCuratorMemorySource(s!.store),
      { kind: "common_global" },
      { maxMemories: 50 },
    ).activeMemories.map((m) => m.id);
    const inProject = gatherMemoryEvidence(
      createVaultCuratorMemorySource(s!.store),
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
      createVaultCuratorMemorySource(s!.store),
      { kind: "common_project", projectKey: "proj-x" },
      { maxMemories: 50 },
    );
    expect(bundle.activeMemories.map((x) => x.id)).toContain(m.id);
  });

  it("a project-scoped memory authored by an agent appears in BOTH agent_private(agent) AND common_project (visibility-based isolation retired)", () => {
    const m = seed({
      title: "priv-with-project",
      agent_id: "agent-a",
      project_key: "proj-x",
    }).memory;
    const commonProj = gatherMemoryEvidence(
      createVaultCuratorMemorySource(s!.store),
      { kind: "common_project", projectKey: "proj-x" },
      { maxMemories: 50 },
    );
    const priv = gatherMemoryEvidence(
      createVaultCuratorMemorySource(s!.store),
      { kind: "agent_private", agentId: "agent-a" },
      { maxMemories: 50 },
    );
    // Section 4d.3 — the memory appears in BOTH slices because the
    // visibility-based isolation that confined it to one is retired.
    // Callers that need per-agent isolation must filter results.
    expect(commonProj.activeMemories.map((x) => x.id)).toContain(m.id);
    expect(priv.activeMemories.map((x) => x.id)).toContain(m.id);
  });
});

describe("gatherMemoryEvidence — redaction (security)", () => {
  it("redacts secret-looking material from bodies before returning", () => {
    seed({ title: "with-secret", body: 'deploy notes — token = "FAKETOKENFAKETOKEN" — ok' });

    const bundle = gatherMemoryEvidence(
      createVaultCuratorMemorySource(s!.store),
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
      createVaultCuratorMemorySource(s!.store),
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
      createVaultCuratorMemorySource(s!.store),
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
      createVaultCuratorMemorySource(s!.store),
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
      createVaultCuratorMemorySource(s!.store),
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
      createVaultCuratorMemorySource(s!.store),
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
        createVaultCuratorMemorySource(s!.store),
        { kind: "common_project" },
        { maxMemories: 5 },
      ),
    ).toThrow(/projectKey/i);
  });

  it("rejects agent_private without an agentId", () => {
    expect(() =>
      gatherMemoryEvidence(
        createVaultCuratorMemorySource(s!.store),
        { kind: "agent_private" },
        { maxMemories: 5 },
      ),
    ).toThrow(/agentId/i);
  });
});
