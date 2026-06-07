// Curator enqueue + run loop (spec §12 + §10.1 locking) over a real store with an
// injected fake LLM client. After plan 046 T4 the per-slice interval gate is
// RETIRED: a pass attempts EVERY slice, and the input-hash idempotency
// (runCuration / findCompletedApplyRun) is the sole gate that skips slices whose
// content has not changed since they last groomed. These tests pin that contract:
// every slice is attempted, an unchanged slice makes 0 LLM calls (idempotency), a
// changed slice runs, a bypassSkip pass re-runs unchanged slices, an active lock
// is honoured, and a stale lock is reclaimed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ApplyPolicy,
  type LibrarianStore,
  type LlmClient,
  createLibrarianStore,
  runDueCuration,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let store: LibrarianStore | null = null;
let dataDir = "";
const NOW = new Date();

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-enqueue-"));
  store = createLibrarianStore({ dataDir });
});
afterEach(() => {
  try {
    store?.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  store = null;
});

const policy: ApplyPolicy = { level: "safe_only", confidenceThreshold: 0.9 };
const noOpClient: LlmClient = {
  complete: async () => ({
    content: JSON.stringify({ operations: [] }),
    model: "gpt-x",
    usage: null,
  }),
};

function seedCommonMemory(projectKey: string, title = "t", body = "b") {
  return store!.createMemory({
    agent_id: "agent-a",
    title,
    body,
    category: "lessons",
    visibility: "common",
    scope: "project",
    project_key: projectKey,
    priority: "normal",
    confidence: "working",
  }).memory;
}

function options(over: Partial<Parameters<typeof runDueCuration>[0]> = {}) {
  return {
    store: store!,
    now: NOW,
    llmClient: noOpClient,
    actorId: "system-memory-curator",
    policy,
    model: { provider: "openai", name: "gpt-x" },
    trigger: "schedule",
    ...over,
  };
}

/** Create a RUNNING run for a common project, with started_at set to the past. */
function runningRun(projectKey: string, startedAt: Date) {
  const run = store!.createCurationRun({
    trigger: "schedule",
    visibility: "common",
    input_hash: `h-${projectKey}`,
    project_key: projectKey,
  });
  store!.startCurationRun(run.id);
  // Backdate started_at in the sidecar runs file so the stale-lock reclaim path
  // can be exercised (the store has no API to set a past started_at).
  const file = path.join(dataDir, "curation-runs.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
    runs: Record<string, { started_at: string }>;
  };
  data.runs[run.id].started_at = startedAt.toISOString();
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return run.id;
}

describe("runDueCuration — attempts every slice (no per-slice interval gate)", () => {
  it("runs every slice in the slice set", async () => {
    seedCommonMemory("proj-x");
    seedCommonMemory("proj-y");

    const summary = await runDueCuration(options());
    // No interval gate: every slice is attempted, and the count of attempted
    // slices equals the full slice set.
    expect(summary.due).toBe(store!.listCuratorSlices().length);
    expect(summary.due).toBeGreaterThanOrEqual(2);
    expect(summary.ran).toBeGreaterThanOrEqual(2);
    expect(summary.skippedLocked).toBe(0);
  });

  it("an UNCHANGED slice makes no LLM call on a re-run (input-hash idempotency)", async () => {
    seedCommonMemory("proj-x");

    const client: LlmClient = { complete: vi.fn(noOpClient.complete) };

    // First pass: the slice has never groomed → it runs (one LLM call).
    const first = await runDueCuration(options({ llmClient: client }));
    expect(first.ran).toBeGreaterThanOrEqual(1);
    const callsAfterFirst = (client.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

    // Second pass with nothing changed: every slice is still ATTEMPTED (it's due),
    // but idempotency skips it — no NEW LLM call, recorded as skippedIdempotent.
    const second = await runDueCuration(options({ llmClient: client }));
    expect(second.due).toBe(first.due); // still attempts every slice
    expect(second.ran).toBe(0);
    expect(second.skippedIdempotent).toBeGreaterThanOrEqual(1);
    expect((client.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst);
  });

  it("a CHANGED slice runs again (its input hash differs)", async () => {
    const mem = seedCommonMemory("proj-x", "title-v1", "body-v1");

    const client: LlmClient = { complete: vi.fn(noOpClient.complete) };
    await runDueCuration(options({ llmClient: client }));
    const callsAfterFirst = (client.complete as ReturnType<typeof vi.fn>).mock.calls.length;

    // Mutate the slice's content → its input hash changes → no completed apply-run
    // matches → the slice runs again (a fresh LLM call).
    store!.updateMemory(mem.id, { body: "body-v2-changed" }, "agent-a");

    const second = await runDueCuration(options({ llmClient: client, now: new Date() }));
    expect(second.ran).toBeGreaterThanOrEqual(1);
    expect((client.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
      callsAfterFirst,
    );
  });

  it("bypassSkip re-runs an unchanged slice (manual/under-eval override)", async () => {
    seedCommonMemory("proj-x");

    const client: LlmClient = { complete: vi.fn(noOpClient.complete) };
    await runDueCuration(options({ llmClient: client }));
    const callsAfterFirst = (client.complete as ReturnType<typeof vi.fn>).mock.calls.length;

    // Same content, but bypassSkip → idempotency is bypassed, the slice runs again.
    const forced = await runDueCuration(options({ llmClient: client, bypassSkip: true }));
    expect(forced.skippedIdempotent).toBe(0);
    expect(forced.ran).toBeGreaterThanOrEqual(1);
    expect((client.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
      callsAfterFirst,
    );
  });

  it("skips a slice that is already locked by an active run", async () => {
    seedCommonMemory("proj-locked");
    runningRun("proj-locked", NOW); // active lock

    const summary = await runDueCuration(options());
    expect(summary.skippedLocked).toBe(1);
    expect(summary.ran).toBe(0);
  });

  it("reclaims a stale lock and runs the slice", async () => {
    seedCommonMemory("proj-stalelock");
    const staleId = runningRun("proj-stalelock", new Date(NOW.getTime() - 3_600_000)); // 1h ago

    const summary = await runDueCuration(options({ lockTtlMs: 30 * 60_000 }));
    expect(summary.reclaimedStaleLocks).toBe(1);
    expect(summary.ran).toBe(1);
    expect(store!.getCurationRun(staleId)?.status).toBe("failed"); // reclaimed
  });

  it("one slice's failure does not abort the rest of the batch", async () => {
    seedCommonMemory("proj-boom");
    seedCommonMemory("proj-ok");
    // Wrap the store so creating a run for proj-boom throws (a store error mid-loop).
    const wrapped = {
      ...store!,
      createCurationRun: (input: Parameters<LibrarianStore["createCurationRun"]>[0]) => {
        if (input.project_key === "proj-boom") throw new Error("boom");
        return store!.createCurationRun(input);
      },
    } as LibrarianStore;

    const summary = await runDueCuration(options({ store: wrapped }));
    expect(summary.errored).toBe(1); // proj-boom threw
    expect(summary.ran).toBe(1); // proj-ok still ran
  });
});
