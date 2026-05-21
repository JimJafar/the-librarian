// V1.3 — Backfill script for the 82-memory cleanup.
//
// Exercises `scripts/replay-verify-outcomes.mjs` end-to-end against a
// synthetic ledger. Asserts: outdated → archive, useful/not_useful →
// usefulness_adjusted event, dry-run vs --apply, idempotent on a second
// --apply run.

import { exec as execCb } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type LibrarianStore, createLibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const exec = promisify(execCb);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "replay-verify-outcomes.mjs");

interface Scope {
  dataDir: string;
  ids: { outdated: string; useful: string; notUseful: string; clean: string };
}

function makeScope(): Scope {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-backfill-"));
  const store = createLibrarianStore({ dataDir });
  const ids = {
    outdated: seedAndVerify(store, "Outdated flag", "outdated"),
    useful: seedAndVerify(store, "Useful note", "useful"),
    notUseful: seedAndVerify(store, "Wrong path note", "not_useful"),
    clean: seedAndVerify(store, "Never verified", null),
  };
  store.close();
  return { dataDir, ids };
}

function seedAndVerify(store: LibrarianStore, title: string, verdict: string | null): string {
  const created = store.createMemory({
    agent_id: "codex",
    title,
    body: `${title} body — pinned by backfill test.`,
    category: "tools",
    visibility: "common",
    scope: "project",
    project_key: "backfill",
  });
  // V1.1 verify_memory(outdated) already archives the row. To simulate a
  // pre-V1.1 ledger where the verdict landed in the events log but the
  // projection didn't react, we append the `memory.verified` event
  // directly via the store's appendEvent escape hatch, then immediately
  // restore an "active" status by appending a no-op update event.
  if (verdict) {
    appendEventRaw(store.eventsPath, {
      event_id: `evt_pre_v_${created.memory.id}`,
      event_type: "memory.verified",
      memory_id: created.memory.id,
      agent_id: "codex",
      created_at: new Date().toISOString(),
      payload: { memory_id: created.memory.id, agent_id: "codex", result: verdict },
    });
  }
  return created.memory.id;
}

function appendEventRaw(eventsPath: string, event: unknown): void {
  fs.appendFileSync(eventsPath, JSON.stringify(event) + "\n", "utf8");
}

function teardown(dataDir: string): void {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

async function runScript(dataDir: string, apply: boolean): Promise<string> {
  const cmd = `node --no-warnings ${JSON.stringify(scriptPath)} --data-dir ${JSON.stringify(dataDir)}${apply ? " --apply" : ""}`;
  const { stdout, stderr } = await exec(cmd);
  return stdout + stderr;
}

describe("V1.3 — replay-verify-outcomes backfill", () => {
  let scope: Scope | null = null;

  beforeEach(() => {
    scope = makeScope();
  });

  afterEach(() => {
    if (scope) teardown(scope.dataDir);
    scope = null;
  });

  it("dry-run reports the plan without mutating the ledger", async () => {
    const { dataDir } = scope!;
    const before = fs.readFileSync(path.join(dataDir, "events.jsonl"), "utf8");
    const out = await runScript(dataDir, false);
    expect(out).toMatch(/DRY-RUN.*1 archived.*2 score-adjusted/);
    const after = fs.readFileSync(path.join(dataDir, "events.jsonl"), "utf8");
    expect(after).toBe(before);
  });

  it("--apply emits memory.archived for outdated verdicts and pushes useful/not_useful scores to the clamp", async () => {
    const { dataDir, ids } = scope!;
    await runScript(dataDir, true);
    // Wipe SQLite so the next open rebuilds from the appended events.
    fs.unlinkSync(path.join(dataDir, "librarian.sqlite"));
    const reopened = createLibrarianStore({ dataDir });
    try {
      expect(reopened.getMemory(ids.outdated)?.status).toBe("archived");
      // Live rebuild already applied +1 from the raw verified event; the
      // synthesised usefulness_adjusted(+2) pushes the score to the clamp.
      expect(reopened.getMemory(ids.useful)?.usefulness_score).toBe(3);
      expect(reopened.getMemory(ids.notUseful)?.usefulness_score).toBe(-3);
      expect(reopened.getMemory(ids.clean)?.status).toBe("active");
      expect(reopened.getMemory(ids.clean)?.usefulness_score).toBe(0);
    } finally {
      reopened.close();
    }
  });

  it("running --apply twice produces no second wave of events", async () => {
    const { dataDir } = scope!;
    await runScript(dataDir, true);
    const afterFirst = fs.readFileSync(path.join(dataDir, "events.jsonl"), "utf8");
    const secondOut = await runScript(dataDir, true);
    expect(secondOut).toMatch(/APPLY.*0 archived.*0 score-adjusted/);
    const afterSecond = fs.readFileSync(path.join(dataDir, "events.jsonl"), "utf8");
    expect(afterSecond).toBe(afterFirst);
  });
});
