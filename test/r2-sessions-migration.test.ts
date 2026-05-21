// R2 — integration tests for the sessions storage migration script and
// the divergence guard. Exercises the scripts as subprocesses against
// temporary data dirs so the behaviour matches what an operator will
// experience running them by hand.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(".");
const MIGRATE_BIN = path.join(REPO_ROOT, "scripts", "migrate-sessions-to-authoritative-sqlite.mjs");
const DIVERGENCE_BIN = path.join(REPO_ROOT, "scripts", "check-session-state-divergence.mjs");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[] = []): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", bin, ...args], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr!.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function seedDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-r2-test-"));
  const fixtureDir = path.join(REPO_ROOT, "test", "fixtures", "pre-migration");
  if (!fs.existsSync(fixtureDir)) throw new Error("pre-migration fixture missing");
  for (const f of ["events.jsonl", "sessions.jsonl"]) {
    fs.copyFileSync(path.join(fixtureDir, f), path.join(dir, f));
  }
  return dir;
}

describe("R2 — migrate-sessions-to-authoritative-sqlite", () => {
  let dataDir: string | null = null;

  beforeEach(() => {
    dataDir = seedDataDir();
  });

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  });

  it("dry run reports timeline + state-transition counts and leaves the legacy ledger untouched", async () => {
    const before = fs.statSync(path.join(dataDir!, "sessions.jsonl")).size;
    const result = await run(MIGRATE_BIN, ["--data-dir", dataDir!]);
    expect(
      result.code,
      `dry run failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stdout).toMatch(/Sessions storage migration/);
    expect(result.stdout).toMatch(/timeline \(kept\)/);
    expect(result.stdout).toMatch(/state transitions/);
    expect(result.stdout).toMatch(/Dry run only/);

    // No file mutation to the source ledger in dry-run mode. (The
    // store initialiser may create an empty session_events.jsonl as a
    // side effect of opening the DB — that's fine, the migration
    // treats an empty file as a non-conflict on --apply.)
    expect(fs.existsSync(path.join(dataDir!, "sessions.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir!, "sessions.legacy.jsonl"))).toBe(false);
    expect(fs.statSync(path.join(dataDir!, "sessions.jsonl")).size).toBe(before);
    if (fs.existsSync(path.join(dataDir!, "session_events.jsonl"))) {
      expect(fs.readFileSync(path.join(dataDir!, "session_events.jsonl"), "utf8").trim()).toBe("");
    }
  });

  it("--apply renames sessions.jsonl and writes session_events.jsonl", async () => {
    const result = await run(MIGRATE_BIN, ["--data-dir", dataDir!, "--apply"]);
    expect(result.code, `apply failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(
      0,
    );

    expect(fs.existsSync(path.join(dataDir!, "sessions.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(dataDir!, "sessions.legacy.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir!, "session_events.jsonl"))).toBe(true);

    // Every line in session_events.jsonl is a timeline event (never a
    // state transition).
    const lines = fs
      .readFileSync(path.join(dataDir!, "session_events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean);
    const TIMELINE = new Set([
      "session.event_recorded",
      "session.attached_to_harness",
      "session.promoted_to_memory",
    ]);
    for (const line of lines) {
      const event = JSON.parse(line);
      expect(TIMELINE.has(event.event_type), `non-timeline line: ${event.event_type}`).toBe(true);
    }
  });

  it("a second --apply run is a no-op (idempotent)", async () => {
    await run(MIGRATE_BIN, ["--data-dir", dataDir!, "--apply"]);
    const second = await run(MIGRATE_BIN, ["--data-dir", dataDir!, "--apply"]);
    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(/already migrated/);
  });

  it("refuses to overwrite a non-empty existing session_events.jsonl on --apply", async () => {
    // Pre-create the file with content to simulate a partial /
    // repeated migration. (An empty `session_events.jsonl` is fine —
    // the runtime touches that file on init.)
    fs.writeFileSync(
      path.join(dataDir!, "session_events.jsonl"),
      '{"event_id":"sevt_pre"}\n',
      "utf8",
    );
    const result = await run(MIGRATE_BIN, ["--data-dir", dataDir!, "--apply"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/already has content/);
    // sessions.jsonl wasn't renamed since we aborted.
    expect(fs.existsSync(path.join(dataDir!, "sessions.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir!, "sessions.legacy.jsonl"))).toBe(false);
  });
});

describe("R2 — check-session-state-divergence", () => {
  it("exits 0 against the pre-migration fixture (clean SQLite ↔ state-changes parity)", async () => {
    const result = await run(DIVERGENCE_BIN);
    expect(
      result.code,
      `divergence check failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(result.stdout).toMatch(/all in parity/);
  });

  it("exits 1 when SQLite status is forced out of sync with session_state_changes", async () => {
    const dir = seedDataDir();
    try {
      // Open the store, force a divergence by directly mutating
      // sessions.status without touching session_state_changes, close,
      // and re-run the check.
      const { createLibrarianStore } = await import("@librarian/core");
      const store = createLibrarianStore({ dataDir: dir });
      try {
        const row = store.db.prepare("SELECT id FROM sessions LIMIT 1").get() as
          | { id: string }
          | undefined;
        if (!row) throw new Error("no sessions in fixture");
        store.db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run("ended", row.id);
      } finally {
        store.close();
      }

      const result = await run(DIVERGENCE_BIN, ["--data-dir", dir]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/diverged/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
