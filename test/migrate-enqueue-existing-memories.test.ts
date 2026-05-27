// migrate-enqueue-existing-memories.mjs — Section 4d cutover backfill.
//
// Event-sourced: writes `memory.updated` events with patch
// `{classified: 0}` so the projection rebuild on next mcp-server boot
// (or explicit `pnpm rebuild`) lands every memory at classified=0
// without silently reverting on subsequent rebuilds.

import { exec as execCb } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createLibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const exec = promisify(execCb);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "migrate-enqueue-existing-memories.mjs");

let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-enqueue-migrate-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function seedTwoMemories(): void {
  const store = createLibrarianStore({ dataDir });
  store.createMemory({
    agent_id: "codex",
    title: "Legacy memory one",
    body: "Body one.",
    category: "tools",
  });
  store.createMemory({
    agent_id: "codex",
    title: "Legacy memory two",
    body: "Body two.",
    category: "preferences",
  });
  store.close();
}

function classifiedCounts(): { zero: number; one: number; total: number } {
  const store = createLibrarianStore({ dataDir });
  try {
    const zero = store.db
      .prepare("SELECT COUNT(*) AS n FROM memories WHERE classified = 0")
      .get() as { n: number };
    const one = store.db
      .prepare("SELECT COUNT(*) AS n FROM memories WHERE classified = 1")
      .get() as { n: number };
    const total = store.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as {
      n: number;
    };
    return { zero: Number(zero.n), one: Number(one.n), total: Number(total.n) };
  } finally {
    store.close();
  }
}

function countEnqueueEvents(): number {
  const events = fs
    .readFileSync(path.join(dataDir, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event_type: string; payload?: Record<string, unknown> });
  return events.filter(
    (e) =>
      e.event_type === "memory.updated" &&
      (e.payload as Record<string, unknown> | undefined)?.reason === "classifier-cutover-backfill",
  ).length;
}

describe("migrate-enqueue-existing-memories", () => {
  it("dry-run reports counts without mutating", async () => {
    seedTwoMemories();
    const before = classifiedCounts();
    expect(before.one).toBe(2);
    expect(before.zero).toBe(0);
    expect(countEnqueueEvents()).toBe(0);

    await exec(`node "${scriptPath}" --data-dir "${dataDir}"`);
    expect(classifiedCounts()).toEqual(before);
    expect(countEnqueueEvents()).toBe(0);
  });

  it("--apply appends one memory.updated event per row and the next rebuild flips classified to 0", async () => {
    seedTwoMemories();
    await exec(`node "${scriptPath}" --data-dir "${dataDir}" --apply`);
    expect(countEnqueueEvents()).toBe(2);
    // Re-open the store to trigger a rebuild of the projection from
    // events.jsonl. The new events should land the rows at classified=0.
    const store = createLibrarianStore({ dataDir });
    try {
      store.rebuildIndex();
    } finally {
      store.close();
    }
    const counts = classifiedCounts();
    expect(counts.zero).toBe(counts.total);
    expect(counts.one).toBe(0);
  });

  it("subsequent rebuild does NOT silently revert the migration (events stay on disk)", async () => {
    seedTwoMemories();
    await exec(`node "${scriptPath}" --data-dir "${dataDir}" --apply`);
    const storeA = createLibrarianStore({ dataDir });
    storeA.rebuildIndex();
    storeA.close();
    // Second rebuild — same events, same result.
    const storeB = createLibrarianStore({ dataDir });
    storeB.rebuildIndex();
    storeB.close();
    expect(classifiedCounts().zero).toBe(2);
  });

  it("refuses to re-apply when every memory is already classified=0 (idempotency guard)", async () => {
    seedTwoMemories();
    await exec(`node "${scriptPath}" --data-dir "${dataDir}" --apply`);
    const store = createLibrarianStore({ dataDir });
    store.rebuildIndex();
    store.close();
    const eventsBefore = countEnqueueEvents();

    const { stderr } = await exec(`node "${scriptPath}" --data-dir "${dataDir}" --apply`);
    expect(stderr).toMatch(/refusing to append a second wave/i);
    expect(countEnqueueEvents()).toBe(eventsBefore);
  });

  it("--force overrides the idempotency guard", async () => {
    seedTwoMemories();
    await exec(`node "${scriptPath}" --data-dir "${dataDir}" --apply`);
    const store = createLibrarianStore({ dataDir });
    store.rebuildIndex();
    store.close();
    const eventsBefore = countEnqueueEvents();
    await exec(`node "${scriptPath}" --data-dir "${dataDir}" --apply --force`);
    expect(countEnqueueEvents()).toBe(eventsBefore + 2);
  });

  it("fails fast when the data dir has no librarian.sqlite", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-enqueue-empty-"));
    try {
      await expect(exec(`node "${scriptPath}" --data-dir "${emptyDir}"`)).rejects.toMatchObject({
        code: 1,
      });
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
