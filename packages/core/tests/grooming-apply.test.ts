// Curator apply execution (spec §11 + §11.1) — the live-memory mutation layer.
// Integration test against a real store: seed memories, open a curation run, run
// applyOperations over validated operations, and assert both the resulting store
// state and the recorded audit operations.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ApplyPolicy,
  type ApplyStore,
  type LibrarianStore,
  type ValidatedOperation,
  type ValidationContext,
  applyOperations,
  createLibrarianStore,
  createVaultGroomingMemorySource,
  gatherMemoryEvidence,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Scope {
  store: LibrarianStore;
  dataDir: string;
  runId: string;
}

let s: Scope | null = null;

beforeEach(() => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-apply-"));
  const store = createLibrarianStore({ dataDir });
  const run = store.createCurationRun({
    trigger: "manual",
    visibility: "common",
    input_hash: "hash",
    project_key: "proj-x",
  });
  s = { store, dataDir, runId: run.id };
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

function seed(over: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  return s!.store.createMemory(
    {
      agent_id: "agent-a",
      title: "title",
      body: "body",
      category: "lessons",
      visibility: "common",
      scope: "project",
      project_key: "proj-x",
      priority: "normal",
      confidence: "working",
      ...over,
    },
    options,
  ).memory;
}

function context(prepass: ValidationContext["prepass"] = { findings: [] }): ValidationContext {
  const slice = { kind: "common_project" as const, projectKey: "proj-x" };
  return {
    slice,
    memory: gatherMemoryEvidence(createVaultGroomingMemorySource(s!.store), slice, {
      maxMemories: 100,
    }),
    prepass,
  };
}

const policy = (level: ApplyPolicy["level"], confidenceThreshold = 0.9): ApplyPolicy => ({
  level,
  confidenceThreshold,
});

function deps(level: ApplyPolicy["level"] = "high_confidence") {
  return {
    store: s!.store,
    runId: s!.runId,
    actorId: "system-memory-curator",
    policy: policy(level),
  };
}

const accept = (risk: string, isProtected = false) =>
  ({ decision: "accept", risk, isProtected }) as ValidatedOperation["outcome"];

function ops(...validated: ValidatedOperation[]): ValidatedOperation[] {
  return validated;
}

function recorded() {
  return s!.store.getCurationOperations(s!.runId);
}

describe("applyOperations — auto-apply", () => {
  it("archives the source memories of an archive op", () => {
    const m = seed();
    const summary = applyOperations(
      ops({
        operation: {
          type: "archive",
          source_memory_ids: [m.id],
          rationale: "dup",
          confidence: 0.95,
        },
        outcome: accept("safe"),
      }),
      context(),
      deps(),
    );
    expect(summary.applied).toBe(1);
    expect(s!.store.getMemory(m.id)?.status).toBe("archived");
    expect(recorded()[0]).toMatchObject({ operation_type: "archive", status: "applied" });
  });

  it("creates a new active memory with curator-note provenance", () => {
    const summary = applyOperations(
      ops({
        operation: {
          type: "create",
          memory: {
            title: "New fact",
            body: "the body",
            category: "lessons",
            visibility: "common",
            scope: "project",
            project_key: "proj-x",
          },
          rationale: "durable",
          confidence: 0.95,
        },
        outcome: accept("normal"),
      }),
      context(),
      deps(),
    );
    expect(summary.applied).toBe(1);
    const targetId = recorded()[0]!.target_memory_ids[0]!;
    const created = s!.store.getMemory(targetId)!;
    expect(created.status).toBe("active");
    expect(created.title).toBe("New fact");
    expect(created.curator_note?.run_id).toBe(s!.runId);
  });

  // Regression (spec 044 D-5a): the grooming merge path now routes through the
  // shared `mergeMemory` store primitive (the sibling of `splitMemory`). Its
  // behaviour must be UNCHANGED — create the merged replacement (superseding the
  // sources, carrying the run_id), then archive every source.
  it("merges: creates the replacement and archives the sources atomically", () => {
    const a = seed({ title: "A", body: "same" });
    const b = seed({ title: "B", body: "same" });
    const summary = applyOperations(
      ops({
        operation: {
          type: "merge",
          source_memory_ids: [a.id, b.id],
          replacement: {
            title: "Merged",
            body: "merged body",
            category: "lessons",
            visibility: "common",
            scope: "project",
            project_key: "proj-x",
          },
          rationale: "merge dups",
          confidence: 0.95,
        },
        outcome: accept("safe"),
      }),
      context(),
      deps(),
    );
    expect(summary.applied).toBe(1);
    expect(s!.store.getMemory(a.id)?.status).toBe("archived");
    expect(s!.store.getMemory(b.id)?.status).toBe("archived");
    const merged = s!.store.getMemory(recorded()[0]!.target_memory_ids[0]!)!;
    expect(merged.status).toBe("active");
    expect(merged.curator_note?.supersedes).toEqual([a.id, b.id]);
    expect(merged.curator_note?.run_id).toBe(s!.runId); // provenance unchanged by the refactor
  });

  // Regression: the grooming split path now routes through the shared
  // `splitMemory` store primitive (spec 043 D-B). Its behaviour must be
  // UNCHANGED — spin each replacement into a new active memory superseding the
  // source, then archive the source.
  it("splits: spins the source into N active replacements and archives the source", () => {
    const src = seed({ title: "Mixed", body: "facts about Anna and Bob" });
    const replacement = (title: string, body: string) => ({
      title,
      body,
      category: "lessons",
      visibility: "common" as const,
      scope: "project",
      project_key: "proj-x",
    });
    const summary = applyOperations(
      ops({
        operation: {
          type: "split",
          source_memory_id: src.id,
          replacements: [replacement("Anna", "about Anna"), replacement("Bob", "about Bob")],
          rationale: "two distinct entities",
          confidence: 0.95,
        },
        outcome: accept("safe"),
      }),
      context(),
      deps(),
    );
    expect(summary.applied).toBe(1);
    // The source is archived (auto-applied split supersedes it).
    expect(s!.store.getMemory(src.id)?.status).toBe("archived");
    const targets = recorded()[0]!.target_memory_ids;
    expect(targets.length).toBe(2);
    for (const id of targets) {
      const t = s!.store.getMemory(id)!;
      expect(t.status).toBe("active");
      expect(t.curator_note?.supersedes).toEqual([src.id]);
      expect(t.curator_note?.run_id).toBe(s!.runId);
    }
  });
});

describe("applyOperations — protected routing", () => {
  it("routes a protected create to a proposal, not an active memory", () => {
    const summary = applyOperations(
      ops({
        operation: {
          type: "create",
          memory: {
            title: "Identity fact",
            body: "who they are",
            category: "identity",
            visibility: "common",
            scope: "project",
            project_key: "proj-x",
          },
          rationale: "identity",
          confidence: 0.95,
        },
        outcome: accept("protected", true),
      }),
      context(),
      deps(),
    );
    expect(summary.proposed).toBe(1);
    expect(summary.applied).toBe(0);
    const proposedOp = recorded().find((o) => o.status === "proposed")!;
    expect(s!.store.getMemory(proposedOp.target_memory_ids[0]!)?.status).toBe("proposed");
  });

  it("skips a protected pure archive (no proposal, source untouched)", () => {
    // Seed an ACTIVE memory; "protected" is injected via the validation
    // outcome below (the category gate is retired).
    const m = seed({ category: "relationship" });
    expect(s!.store.getMemory(m.id)?.status).toBe("active");
    const summary = applyOperations(
      ops({
        operation: {
          type: "archive",
          source_memory_ids: [m.id],
          rationale: "stale",
          confidence: 0.99,
        },
        outcome: accept("protected", true),
      }),
      context(),
      deps(),
    );
    expect(summary.skipped).toBe(1);
    expect(s!.store.getMemory(m.id)?.status).toBe("active"); // NOT archived
    expect(recorded()[0]).toMatchObject({ operation_type: "archive", status: "skipped" });
  });

  // Regression: a PROTECTED split proposes its replacements (status=proposed) and
  // leaves the source ACTIVE — the admin archives it after accepting (§11.1). The
  // shared primitive must not archive the source when no actor is passed.
  it("proposes a protected split's replacements and leaves the source active", () => {
    const src = seed({ category: "identity" });
    expect(s!.store.getMemory(src.id)?.status).toBe("active");
    const replacement = (title: string) => ({
      title,
      body: `about ${title}`,
      category: "identity",
      visibility: "common" as const,
      scope: "project",
      project_key: "proj-x",
    });
    const summary = applyOperations(
      ops({
        operation: {
          type: "split",
          source_memory_id: src.id,
          replacements: [replacement("Anna"), replacement("Bob")],
          rationale: "two people",
          confidence: 0.95,
        },
        outcome: accept("protected", true),
      }),
      context(),
      deps(),
    );
    expect(summary.proposed).toBe(1);
    expect(summary.applied).toBe(0);
    expect(s!.store.getMemory(src.id)?.status).toBe("active"); // source NOT archived
    const targets = recorded().find((o) => o.status === "proposed")!.target_memory_ids;
    expect(targets.length).toBe(2);
    for (const id of targets) {
      expect(s!.store.getMemory(id)?.status).toBe("proposed");
    }
  });
});

describe("applyOperations — protected update reconstruction (data integrity)", () => {
  it("proposes the corrected memory from the authoritative record, preserving untouched fields", () => {
    // Active protected memory with a body longer than the evidence truncation cap
    // and a non-default priority — both must survive a title-only patch.
    const fullBody = "X".repeat(5000);
    const m = seed({ category: "identity", body: fullBody, priority: "high", tags: ["keep"] });

    const summary = applyOperations(
      ops({
        operation: {
          type: "update",
          source_memory_id: m.id,
          patch: { title: "Corrected title" },
          rationale: "fix",
          confidence: 0.95,
        },
        outcome: accept("protected", true),
      }),
      context(),
      deps(),
    );

    expect(summary.proposed).toBe(1);
    const proposalId = recorded().find((o) => o.status === "proposed")!.target_memory_ids[0]!;
    const proposal = s!.store.getMemory(proposalId)!;
    expect(proposal.status).toBe("proposed");
    expect(proposal.title).toBe("Corrected title");
    expect(proposal.body).toBe(fullBody); // full, untruncated, unredacted
    expect(proposal.priority).toBe("high"); // preserved, not reset to default
    expect(proposal.tags).toContain("keep");
    expect(proposal.curator_note?.supersedes).toEqual([m.id]);
  });
});

describe("applyOperations — merge partial failure (no data loss)", () => {
  it("keeps the created replacement and records failed when a source archive throws", () => {
    const created: string[] = [];
    const recordedOps: { status: string }[] = [];
    let archiveCalls = 0;
    const onError = vi.fn();
    const mockStore: ApplyStore = {
      createMemory: () => {
        const id = `mem_new_${created.length}`;
        created.push(id);
        return { memory: { id } };
      },
      updateMemory: () => null,
      archiveMemory: () => {
        archiveCalls++;
        if (archiveCalls === 2) throw new Error("archive boom");
        return null;
      },
      getMemory: () => null,
      recordCurationOperation: (op) => {
        recordedOps.push({ status: op.status });
        return op;
      },
    };
    const slice = { kind: "common_project" as const, projectKey: "proj-x" };
    const minimalContext: ValidationContext = {
      slice,
      memory: {
        slice,
        activeMemories: [],
        proposedMemories: [],
        tombstones: [],
        truncatedMemories: false,
        truncatedFields: false,
        redactionCount: 0,
      },
      prepass: { findings: [] },
    };

    const summary = applyOperations(
      ops({
        operation: {
          type: "merge",
          source_memory_ids: ["a", "b"],
          replacement: {
            title: "Merged",
            body: "merged",
            category: "lessons",
            visibility: "common",
            scope: "project",
            project_key: "proj-x",
          },
          rationale: "merge",
          confidence: 0.95,
        },
        outcome: accept("safe"),
      }),
      minimalContext,
      {
        store: mockStore,
        runId: "run_x",
        actorId: "system-memory-curator",
        policy: policy("safe_only"),
        onError,
      },
    );

    expect(summary.failed).toBe(1);
    expect(created).toHaveLength(1); // replacement created → no data loss
    expect(recordedOps[0]?.status).toBe("failed");
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("applyOperations — skips + rejects mutate nothing", () => {
  it("records a rejected operation as skipped without mutating", () => {
    const m = seed();
    const summary = applyOperations(
      ops({
        operation: { type: "archive", source_memory_ids: [m.id], rationale: "x", confidence: 0.9 },
        outcome: { decision: "reject", reason: "references a memory not in the evidence" },
      }),
      context(),
      deps(),
    );
    expect(summary.skipped).toBe(1);
    expect(s!.store.getMemory(m.id)?.status).toBe("active");
    expect(recorded()[0]?.status).toBe("skipped");
  });

  it("skips a below-threshold op under the policy without mutating", () => {
    const m = seed();
    const summary = applyOperations(
      ops({
        operation: { type: "archive", source_memory_ids: [m.id], rationale: "x", confidence: 0.5 },
        outcome: accept("safe"),
      }),
      context(),
      deps("safe_only"),
    );
    expect(summary.skipped).toBe(1);
    expect(s!.store.getMemory(m.id)?.status).toBe("active");
  });
});

// ── Under-evaluation force-propose (spec 044 D-3) ────────────────────────────
//
// While the grooming addendum is under_evaluation, NO non-protected op auto-
// applies: a would-be auto-apply is routed to a PROPOSAL (tagged with the eval
// version) and a would-be auto-archive is SKIPPED (archive is not proposable —
// the wrinkle). Protected ops already route to propose/skip and are unchanged.
// When accepted (the default) behaviour is byte-identical to before D3a.
describe("applyOperations — under_evaluation force-propose (spec 044 D-3)", () => {
  // high_confidence so EVERY non-protected op would otherwise auto-apply.
  function evalDeps(addendumVersion: string | null = "evalhash123") {
    return {
      store: s!.store,
      runId: s!.runId,
      actorId: "system-memory-curator",
      policy: policy("high_confidence"),
      underEvaluation: true as const,
      addendumVersion,
    };
  }

  it("a would-be auto-apply create is PROPOSED (not applied) and tagged", () => {
    const summary = applyOperations(
      ops({
        operation: {
          type: "create",
          memory: {
            title: "New",
            body: "the body",
            category: "lessons",
            visibility: "common",
            scope: "project",
            project_key: "proj-x",
          },
          rationale: "durable",
          confidence: 0.99,
        },
        outcome: accept("normal"),
      }),
      context(),
      evalDeps(),
    );
    expect(summary.proposed).toBe(1);
    expect(summary.applied).toBe(0);
    const op = recorded().find((o) => o.status === "proposed")!;
    const proposal = s!.store.getMemory(op.target_memory_ids[0]!)!;
    expect(proposal.status).toBe("proposed");
    expect(proposal.curator_note?.addendum_version).toBe("evalhash123");
    expect(proposal.curator_note?.run_id).toBe(s!.runId);
  });

  it("a would-be auto-apply update is PROPOSED, the source untouched, tagged", () => {
    const m = seed({ title: "Orig", body: "orig body" });
    const summary = applyOperations(
      ops({
        operation: {
          type: "update",
          source_memory_id: m.id,
          patch: { title: "Edited" },
          rationale: "edit",
          confidence: 0.99,
        },
        outcome: accept("normal"),
      }),
      context(),
      evalDeps(),
    );
    expect(summary.proposed).toBe(1);
    expect(summary.applied).toBe(0);
    expect(s!.store.getMemory(m.id)?.title).toBe("Orig"); // source NOT mutated
    const op = recorded().find((o) => o.status === "proposed")!;
    const proposal = s!.store.getMemory(op.target_memory_ids[0]!)!;
    expect(proposal.title).toBe("Edited"); // reconstructed from the authoritative record
    expect(proposal.curator_note?.addendum_version).toBe("evalhash123");
    expect(proposal.curator_note?.supersedes).toEqual([m.id]);
  });

  it("a would-be auto-apply merge is PROPOSED, sources stay active, tagged", () => {
    const a = seed({ title: "A", body: "same" });
    const b = seed({ title: "B", body: "same" });
    const summary = applyOperations(
      ops({
        operation: {
          type: "merge",
          source_memory_ids: [a.id, b.id],
          replacement: {
            title: "Merged",
            body: "merged body",
            category: "lessons",
            visibility: "common",
            scope: "project",
            project_key: "proj-x",
          },
          rationale: "dups",
          confidence: 0.99,
        },
        outcome: accept("safe"),
      }),
      context(),
      evalDeps(),
    );
    expect(summary.proposed).toBe(1);
    expect(summary.applied).toBe(0);
    // The would-be-archived sources stay ACTIVE (a proposal, not an apply).
    expect(s!.store.getMemory(a.id)?.status).toBe("active");
    expect(s!.store.getMemory(b.id)?.status).toBe("active");
    const op = recorded().find((o) => o.status === "proposed")!;
    expect(s!.store.getMemory(op.target_memory_ids[0]!)?.curator_note?.addendum_version).toBe(
      "evalhash123",
    );
  });

  it("a would-be auto-apply split is PROPOSED, source stays active, tagged", () => {
    const src = seed({ title: "Mixed", body: "Anna and Bob" });
    const replacement = (title: string) => ({
      title,
      body: `about ${title}`,
      category: "lessons",
      visibility: "common" as const,
      scope: "project",
      project_key: "proj-x",
    });
    const summary = applyOperations(
      ops({
        operation: {
          type: "split",
          source_memory_id: src.id,
          replacements: [replacement("Anna"), replacement("Bob")],
          rationale: "two entities",
          confidence: 0.99,
        },
        outcome: accept("safe"),
      }),
      context(),
      evalDeps(),
    );
    expect(summary.proposed).toBe(1);
    expect(summary.applied).toBe(0);
    expect(s!.store.getMemory(src.id)?.status).toBe("active"); // source NOT archived
    const targets = recorded().find((o) => o.status === "proposed")!.target_memory_ids;
    expect(targets.length).toBe(2);
    for (const id of targets) {
      const t = s!.store.getMemory(id)!;
      expect(t.status).toBe("proposed");
      expect(t.curator_note?.addendum_version).toBe("evalhash123");
    }
  });

  it("a would-be auto-ARCHIVE is SKIPPED, not proposed (the archive wrinkle)", () => {
    const m = seed();
    const summary = applyOperations(
      ops({
        operation: {
          type: "archive",
          source_memory_ids: [m.id],
          rationale: "dup",
          confidence: 0.99,
        },
        outcome: accept("safe"),
      }),
      context(),
      evalDeps(),
    );
    expect(summary.skipped).toBe(1);
    expect(summary.proposed).toBe(0);
    expect(summary.applied).toBe(0);
    expect(s!.store.getMemory(m.id)?.status).toBe("active"); // NOT archived
    expect(recorded()[0]).toMatchObject({ operation_type: "archive", status: "skipped" });
  });

  it("a noop stays skipped under evaluation (nothing proposed)", () => {
    const m = seed();
    const summary = applyOperations(
      ops({
        operation: { type: "noop", source_memory_ids: [m.id], rationale: "ok", confidence: 0.99 },
        outcome: accept("safe"),
      }),
      context(),
      evalDeps(),
    );
    expect(summary.skipped).toBe(1);
    expect(summary.proposed).toBe(0);
  });

  it("under_evaluation without a version produces a proposal with NO addendum_version key", () => {
    const summary = applyOperations(
      ops({
        operation: {
          type: "create",
          memory: {
            title: "New",
            body: "b",
            category: "lessons",
            visibility: "common",
            scope: "project",
            project_key: "proj-x",
          },
          rationale: "d",
          confidence: 0.99,
        },
        outcome: accept("normal"),
      }),
      context(),
      evalDeps(null),
    );
    expect(summary.proposed).toBe(1);
    const op = recorded().find((o) => o.status === "proposed")!;
    const note = s!.store.getMemory(op.target_memory_ids[0]!)!.curator_note!;
    expect(note).not.toHaveProperty("addendum_version");
  });

  it("ACCEPTED (default, no underEvaluation) is byte-identical: auto-apply still applies + archives", () => {
    // create auto-applies (active, no addendum_version tag).
    const createSummary = applyOperations(
      ops({
        operation: {
          type: "create",
          memory: {
            title: "New",
            body: "b",
            category: "lessons",
            visibility: "common",
            scope: "project",
            project_key: "proj-x",
          },
          rationale: "d",
          confidence: 0.99,
        },
        outcome: accept("normal"),
      }),
      context(),
      deps(), // high_confidence, NO underEvaluation
    );
    expect(createSummary.applied).toBe(1);
    const created = s!.store.getMemory(recorded()[0]!.target_memory_ids[0]!)!;
    expect(created.status).toBe("active");
    expect(created.curator_note).not.toHaveProperty("addendum_version");

    // archive still archives.
    const m = seed();
    const archiveSummary = applyOperations(
      ops({
        operation: { type: "archive", source_memory_ids: [m.id], rationale: "x", confidence: 0.99 },
        outcome: accept("safe"),
      }),
      context(),
      deps(),
    );
    expect(archiveSummary.applied).toBe(1);
    expect(s!.store.getMemory(m.id)?.status).toBe("archived");
  });
});
