// Curator enqueue + run loop (spec §12 + §10.1 locking) over a real store with an
// injected fake LLM client. After plan 046 T4 the per-slice interval gate is
// RETIRED: a pass attempts EVERY slice, and the input-hash idempotency
// (runCuration / findCompletedApplyRun) is the sole gate that skips slices whose
// content has not changed since they last groomed. Memories are project-less, so
// the slice set is a SINGLE common_global slice. These tests pin that contract:
// the global slice is attempted, an unchanged slice makes 0 LLM calls
// (idempotency), a changed slice runs, a bypassSkip pass re-runs unchanged
// slices, an active lock is honoured, and a stale lock is reclaimed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
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

const confidenceThreshold = 0.8; // the single D13 knob
const noOpClient: LlmClient = {
  complete: async () => ({
    content: JSON.stringify({ operations: [] }),
    model: "gpt-x",
    usage: null,
  }),
};

function seedCommonMemory(title = "t", body = "b") {
  return store!.createMemory({
    agent_id: "agent-a",
    title,
    body,
    visibility: "common",
    confidence: "working",
  }).memory;
}

function options(over: Partial<Parameters<typeof runDueCuration>[0]> = {}) {
  return {
    store: store!,
    now: NOW,
    llmClient: noOpClient,
    actorId: "system-memory-curator",
    confidenceThreshold,
    model: { provider: "openai", name: "gpt-x" },
    trigger: "schedule",
    ...over,
  };
}

/** Create a RUNNING run for the global slice, with started_at set to the past. */
function runningRun(startedAt: Date) {
  const run = store!.createCurationRun({
    trigger: "schedule",
    visibility: "common",
    input_hash: "h-global",
    project_key: null,
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
  it("runs the single global slice in the slice set", async () => {
    seedCommonMemory("one");
    seedCommonMemory("two");

    const summary = await runDueCuration(options());
    // No interval gate: every slice is attempted. Memories are project-less, so
    // the slice set is exactly one global slice.
    expect(summary.due).toBe(store!.listGroomingSlices().length);
    expect(summary.due).toBe(1);
    expect(summary.ran).toBe(1);
    expect(summary.skippedLocked).toBe(0);
  });

  it("an UNCHANGED slice makes no LLM call on a re-run (input-hash idempotency)", async () => {
    seedCommonMemory("one");

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
    const mem = seedCommonMemory("title-v1", "body-v1");

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

  it("bypassSkip re-runs an unchanged slice (the run-now override)", async () => {
    seedCommonMemory("one");

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

  it("skips the slice when it is already locked by an active run", async () => {
    seedCommonMemory("locked");
    runningRun(NOW); // active lock on the global slice

    const summary = await runDueCuration(options());
    expect(summary.skippedLocked).toBe(1);
    expect(summary.ran).toBe(0);
  });

  it("reclaims a stale lock and runs the slice", async () => {
    seedCommonMemory("stalelock");
    const staleId = runningRun(new Date(NOW.getTime() - 3_600_000)); // 1h ago

    const summary = await runDueCuration(options({ lockTtlMs: 30 * 60_000 }));
    expect(summary.reclaimedStaleLocks).toBe(1);
    expect(summary.ran).toBe(1);
    expect(store!.getCurationRun(staleId)?.status).toBe("failed"); // reclaimed
  });

  it("a slice failure surfaces as an error without leaving a dangling run", async () => {
    seedCommonMemory("boom");
    // Wrap the store so creating the global-slice run throws (a store error mid-loop).
    const wrapped = {
      ...store!,
      createCurationRun: (_input: Parameters<LibrarianStore["createCurationRun"]>[0]) => {
        throw new Error("boom");
      },
    } as LibrarianStore;

    const summary = await runDueCuration(options({ store: wrapped }));
    expect(summary.errored).toBe(1); // the global slice threw
    expect(summary.ran).toBe(0);
  });
});
