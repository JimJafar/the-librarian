// Curator enqueue + run loop (spec §12 + §10.1 locking) over a real store with an
// injected fake LLM client. Pins that due slices run, an active lock is honoured,
// and a stale lock is reclaimed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ApplyPolicy,
  type LibrarianStore,
  type LlmClient,
  type ScheduleConfig,
  createLibrarianStore,
  runDueCuration,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

const schedule = (): ScheduleConfig => ({ intervalMinutes: 60 });
const policy: ApplyPolicy = { level: "safe_only", confidenceThreshold: 0.9 };
const noOpClient: LlmClient = {
  complete: async () => ({
    content: JSON.stringify({ operations: [] }),
    model: "gpt-x",
    usage: null,
  }),
};

function seedCommonMemory(projectKey: string) {
  store!.createMemory({
    agent_id: "agent-a",
    title: "t",
    body: "b",
    category: "lessons",
    visibility: "common",
    scope: "project",
    project_key: projectKey,
    priority: "normal",
    confidence: "working",
  });
}

function options(over: Partial<Parameters<typeof runDueCuration>[0]> = {}) {
  return {
    store: store!,
    now: NOW,
    schedule: schedule(),
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

describe("runDueCuration", () => {
  it("runs every due slice", async () => {
    seedCommonMemory("proj-x");
    seedCommonMemory("proj-y");

    const summary = await runDueCuration(options());
    expect(summary.due).toBeGreaterThanOrEqual(2);
    expect(summary.ran).toBeGreaterThanOrEqual(2);
    expect(summary.skippedLocked).toBe(0);
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
