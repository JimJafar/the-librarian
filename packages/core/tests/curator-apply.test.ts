// Curator apply execution (spec §11 + §11.1) — the live-memory mutation layer.
// Integration test against a real store: seed memories, open a curation run, run
// applyOperations over validated operations, and assert both the resulting store
// state and the recorded audit operations.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ApplyPolicy,
  type LibrarianStore,
  type ValidatedOperation,
  type ValidationContext,
  applyOperations,
  createLibrarianStore,
  gatherMemoryEvidence,
  gatherSessionEvidence,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    memory: gatherMemoryEvidence(s!.store.db, slice, { maxMemories: 100 }),
    sessions: gatherSessionEvidence(s!.store.db, slice, { maxSessions: 100 }),
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
          source_session_ids: [],
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
          source_session_ids: [],
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
