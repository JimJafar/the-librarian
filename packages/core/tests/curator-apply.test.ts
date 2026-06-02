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
  createSqliteCuratorMemorySource,
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
    memory: gatherMemoryEvidence(createSqliteCuratorMemorySource(s!.store.db), slice, {
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
    // Seed an ACTIVE protected memory (forceActive bypasses protected→proposed).
    const m = seed({ category: "relationship" }, { forceActive: true });
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
});

describe("applyOperations — protected update reconstruction (data integrity)", () => {
  it("proposes the corrected memory from the authoritative record, preserving untouched fields", () => {
    // Active protected memory with a body longer than the evidence truncation cap
    // and a non-default priority — both must survive a title-only patch.
    const fullBody = "X".repeat(5000);
    const m = seed(
      { category: "identity", body: fullBody, priority: "high", tags: ["keep"] },
      { forceActive: true },
    );

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
