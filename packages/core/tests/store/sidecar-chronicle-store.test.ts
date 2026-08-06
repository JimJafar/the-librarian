import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJsonChronicleStore } from "@librarian/core";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scope() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-chronicle-runs-"));
  dirs.push(dir);
  let tick = 0;
  return createJsonChronicleStore({
    filePath: path.join(dir, "chronicle-runs.json"),
    now: () => new Date(Date.UTC(2026, 7, 3, 8, 0, tick++)).toISOString(),
    generateId: () => "chr-1",
  });
}

describe("JSON Chronicle run store", () => {
  it("records a complete run lifecycle newest-first", () => {
    const store = scope();
    const run = store.createChronicleRun({
      trigger: "schedule",
      shelf_id: "main",
      shelf_label: null,
      period_start: "2026-07-27T00:00:00.000Z",
      period_end: "2026-08-03T00:00:00.000Z",
      iso_week: "2026-W31",
      partial: false,
      model_provider: "prov-main",
      model_name: "narrator",
    });
    store.startChronicleRun(run.id);
    const complete = store.completeChronicleRun(run.id, {
      narrative: "generated",
      path: "references/chronicle/2026-W31.md",
      duration_ms: 321,
      usage_input_tokens: 100,
      usage_output_tokens: 20,
    });

    expect(complete).toMatchObject({
      id: "chr-1",
      status: "completed",
      narrative: "generated",
      duration_ms: 321,
      usage_input_tokens: 100,
      usage_output_tokens: 20,
      error: null,
    });
    expect(store.listChronicleRuns({ limit: 10 })).toEqual([complete]);
  });

  it("records value-free failures and degrades a corrupt sidecar to empty", () => {
    const store = scope();
    const run = store.createChronicleRun({
      trigger: "manual",
      shelf_id: "main",
      shelf_label: null,
      period_start: "2026-07-27T00:00:00.000Z",
      period_end: "2026-07-29T12:00:00.000Z",
      iso_week: "2026-W31",
      partial: true,
      model_provider: null,
      model_name: null,
    });
    const failed = store.failChronicleRun(run.id, {
      error: "collection_failed",
      duration_ms: 12,
    });
    expect(failed).toMatchObject({ status: "failed", error: "collection_failed", duration_ms: 12 });

    const filePath = path.join(dirs.at(-1)!, "chronicle-runs.json");
    fs.writeFileSync(filePath, "not-json", "utf8");
    expect(store.listChronicleRuns()).toEqual([]);
  });
});
