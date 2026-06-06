// Curator addenda as committed vault files (spec 044 D-1 / PR-1).
//
// Both jobs' prompt addenda move from the single `curator.prompt_addendum`
// setting into git-committed vault files (`<vault>/.curator/intake-addendum.md`,
// `grooming-addendum.md`) so 2C's self-improvement loop can version + roll them
// back by git hash. This pins:
//   - readJobAddendum is fail-soft (missing file → "", null version, no throw)
//     and returns a stable commit hash once the file is committed;
//   - setJobAddendum writes the file AND commits it (it appears in git log);
//   - migrateCuratorAddendum moves curator.prompt_addendum → grooming-addendum.md
//     byte-for-byte, commits it, retires the setting; idempotent + no-clobber;
//     a fresh install (no setting) leaves the file absent → "".

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  createLibrarianStore,
  migrateCuratorAddendum,
  readAddendumStatus,
  readJobAddendum,
  setAddendumStatus,
  setJobAddendum,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Scope {
  store: LibrarianStore;
  dataDir: string;
}

const LEGACY_ADDENDUM_KEY = "curator.prompt_addendum";

function open(dataDir: string): LibrarianStore {
  return createLibrarianStore({ dataDir });
}

function scope(): Scope {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-addendum-"));
  return { store: open(dataDir), dataDir };
}

function teardown(s: Scope | null): void {
  if (!s) return;
  try {
    s.store.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(s.dataDir, { recursive: true, force: true });
}

/** The git log subjects for the vault repo (newest first). */
function vaultLog(dataDir: string): string[] {
  const vaultRoot = path.join(dataDir, "vault");
  try {
    return execGit(vaultRoot, ["log", "--format=%s"]).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Vault-relative paths tracked by git (i.e. files that are actually committed). */
function vaultTracked(dataDir: string): string[] {
  const vaultRoot = path.join(dataDir, "vault");
  try {
    return execGit(vaultRoot, ["ls-files"]).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function execGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).toString();
}

describe("curator addenda as committed vault files (spec 044 D-1)", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  // ── readJobAddendum: fail-soft empty on a fresh install ──────────────────────

  it("returns an empty addendum + null version when the file does not exist", () => {
    const { store } = s!;
    expect(readJobAddendum(store, "grooming")).toEqual({ content: "", version: null });
    expect(readJobAddendum(store, "intake")).toEqual({ content: "", version: null });
  });

  // ── setJobAddendum: writes the file AND commits it ───────────────────────────

  it("setJobAddendum writes the file, commits it, and exposes a stable version hash", () => {
    const { store, dataDir } = s!;
    setJobAddendum(store, "grooming", "prefer merging over archiving");

    const file = path.join(dataDir, "vault", ".curator", "grooming-addendum.md");
    expect(fs.readFileSync(file, "utf8")).toBe("prefer merging over archiving");

    const got = readJobAddendum(store, "grooming");
    expect(got.content).toBe("prefer merging over archiving");
    expect(got.version).toMatch(/^[0-9a-f]{40}$/); // a real commit hash

    // The write is a real git commit: the file is tracked + there's an addendum commit.
    expect(vaultTracked(dataDir)).toContain(".curator/grooming-addendum.md");
    expect(vaultLog(dataDir).some((m) => /addendum grooming/.test(m))).toBe(true);
  });

  it("writes each job to its own file independently", () => {
    const { store, dataDir } = s!;
    setJobAddendum(store, "intake", "intake guidance");
    setJobAddendum(store, "grooming", "grooming guidance");

    expect(readJobAddendum(store, "intake").content).toBe("intake guidance");
    expect(readJobAddendum(store, "grooming").content).toBe("grooming guidance");
    expect(fs.existsSync(path.join(dataDir, "vault", ".curator", "intake-addendum.md"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "vault", ".curator", "grooming-addendum.md"))).toBe(
      true,
    );
  });

  it("the version hash changes when the addendum is re-written", () => {
    const { store } = s!;
    setJobAddendum(store, "grooming", "v1");
    const v1 = readJobAddendum(store, "grooming").version;
    setJobAddendum(store, "grooming", "v2");
    const v2 = readJobAddendum(store, "grooming").version;
    expect(v1).not.toBeNull();
    expect(v2).not.toBeNull();
    expect(v2).not.toBe(v1);
  });

  // ── Migration: curator.prompt_addendum → grooming-addendum.md, byte-for-byte ─

  it("migrates the legacy setting into grooming-addendum.md byte-for-byte and retires the setting", () => {
    const { store, dataDir } = s!;
    const legacy = "Existing operator guidance: prefer condensing.\nKeep it tight.";
    store.setSetting(LEGACY_ADDENDUM_KEY, legacy);

    migrateCuratorAddendum(store);

    // File holds the EXACT bytes the setting held.
    const file = path.join(dataDir, "vault", ".curator", "grooming-addendum.md");
    expect(fs.readFileSync(file, "utf8")).toBe(legacy);
    expect(readJobAddendum(store, "grooming").content).toBe(legacy);

    // The legacy setting is gone.
    expect(store.getSetting(LEGACY_ADDENDUM_KEY)).toBeNull();

    // The migrated file is committed (tracked + in git log) and has a version.
    expect(vaultTracked(dataDir)).toContain(".curator/grooming-addendum.md");
    expect(vaultLog(dataDir).some((m) => /addendum grooming/.test(m))).toBe(true);
    expect(readJobAddendum(store, "grooming").version).toMatch(/^[0-9a-f]{40}$/);
  });

  it("a fresh install with no legacy setting leaves the addendum absent → empty", () => {
    const { store } = s!;
    migrateCuratorAddendum(store);
    expect(readJobAddendum(store, "grooming")).toEqual({ content: "", version: null });
    expect(store.getSetting(LEGACY_ADDENDUM_KEY)).toBeNull();
  });

  it("does not touch the intake addendum during migration", () => {
    const { store } = s!;
    store.setSetting(LEGACY_ADDENDUM_KEY, "grooming-only guidance");
    migrateCuratorAddendum(store);
    expect(readJobAddendum(store, "intake")).toEqual({ content: "", version: null });
  });

  // ── Migration: idempotent + no-clobber ───────────────────────────────────────

  it("is idempotent: re-running does not re-create or change the file", () => {
    const { store } = s!;
    store.setSetting(LEGACY_ADDENDUM_KEY, "original");
    migrateCuratorAddendum(store);
    const v1 = readJobAddendum(store, "grooming").version;

    // The setting is already retired, so a second run is a no-op (no legacy value).
    migrateCuratorAddendum(store);
    const v2 = readJobAddendum(store, "grooming").version;
    expect(v2).toBe(v1);
    expect(readJobAddendum(store, "grooming").content).toBe("original");
  });

  it("no-clobber: never overwrites an existing edited grooming-addendum.md", () => {
    const { store } = s!;
    // The file already exists (the admin edited it after a prior migration).
    setJobAddendum(store, "grooming", "edited by admin");
    // A stale legacy setting is somehow still present.
    store.setSetting(LEGACY_ADDENDUM_KEY, "legacy value");

    migrateCuratorAddendum(store);

    // The edited file wins; the migration must not clobber it.
    expect(readJobAddendum(store, "grooming").content).toBe("edited by admin");
    // The stale legacy setting is retired regardless (it must never re-seed later).
    expect(store.getSetting(LEGACY_ADDENDUM_KEY)).toBeNull();
  });
});

describe("addendum evaluation status round-trip (spec 044 D-3)", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  it("defaults to accepted + null version when unset (the regression default)", () => {
    const { store } = s!;
    expect(readAddendumStatus(store, "grooming")).toEqual({
      status: "accepted",
      evalVersion: null,
    });
    expect(readAddendumStatus(store, "intake")).toEqual({ status: "accepted", evalVersion: null });
  });

  it("begin evaluation captures the CURRENT addendum version automatically", () => {
    const { store } = s!;
    const written = setJobAddendum(store, "grooming", "prefer merging");
    expect(written.version).not.toBeNull();

    setAddendumStatus(store, "grooming", "under_evaluation");

    const got = readAddendumStatus(store, "grooming");
    expect(got.status).toBe("under_evaluation");
    expect(got.evalVersion).toBe(written.version); // the D1 version is pinned
  });

  it("an explicit evalVersion arg wins over the current addendum version", () => {
    const { store } = s!;
    setJobAddendum(store, "intake", "some guidance");
    setAddendumStatus(store, "intake", "under_evaluation", "deadbeefcafe");
    expect(readAddendumStatus(store, "intake")).toEqual({
      status: "under_evaluation",
      evalVersion: "deadbeefcafe",
    });
  });

  it("end evaluation (accepted) clears the eval version and resumes the default", () => {
    const { store } = s!;
    setJobAddendum(store, "grooming", "x");
    setAddendumStatus(store, "grooming", "under_evaluation");
    expect(readAddendumStatus(store, "grooming").status).toBe("under_evaluation");

    setAddendumStatus(store, "grooming", "accepted");
    expect(readAddendumStatus(store, "grooming")).toEqual({
      status: "accepted",
      evalVersion: null,
    });
  });

  it("per-job: intake under_evaluation does not affect grooming (and vice versa)", () => {
    const { store } = s!;
    setJobAddendum(store, "intake", "intake guidance");
    setAddendumStatus(store, "intake", "under_evaluation");

    expect(readAddendumStatus(store, "intake").status).toBe("under_evaluation");
    expect(readAddendumStatus(store, "grooming")).toEqual({
      status: "accepted",
      evalVersion: null,
    });
  });

  it("entering evaluation with no committed addendum leaves evalVersion null", () => {
    const { store } = s!;
    // No setJobAddendum → the file is absent → version null.
    setAddendumStatus(store, "grooming", "under_evaluation");
    expect(readAddendumStatus(store, "grooming")).toEqual({
      status: "under_evaluation",
      evalVersion: null,
    });
  });
});

describe("addendum roll-back to the prior committed version (spec 044 D-3b)", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  it("restores the addendum file to its prior committed content and records a NEW commit", () => {
    const { store, dataDir } = s!;
    const v1 = setJobAddendum(store, "grooming", "v1 guidance");
    const v2 = setJobAddendum(store, "grooming", "v2 guidance (under evaluation)");
    expect(v2.version).not.toBe(v1.version);

    const result = store.rollbackAddendum("grooming");

    // The file content is restored to v1.
    expect(readJobAddendum(store, "grooming").content).toBe("v1 guidance");
    const file = path.join(dataDir, "vault", ".curator", "grooming-addendum.md");
    expect(fs.readFileSync(file, "utf8")).toBe("v1 guidance");

    // The restoration is itself a NEW commit (revertable), distinct from v1/v2.
    expect(result.restored).toBe(true);
    expect(result.version).toMatch(/^[0-9a-f]{40}$/);
    expect(result.version).not.toBe(v1.version);
    expect(result.version).not.toBe(v2.version);
    expect(readJobAddendum(store, "grooming").version).toBe(result.version);

    // The new commit is at the head of the file's history and mentions roll-back.
    expect(vaultLog(dataDir).some((m) => /rollback grooming/.test(m))).toBe(true);
    expect(vaultLog(dataDir)[0]).toMatch(/rollback grooming/);
  });

  it("rolling back a single-version addendum safely restores it to empty", () => {
    const { store, dataDir } = s!;
    const v1 = setJobAddendum(store, "grooming", "only ever version");

    const result = store.rollbackAddendum("grooming");

    // No prior version → restore to the pre-existence state (empty content).
    expect(readJobAddendum(store, "grooming").content).toBe("");
    expect(result.restored).toBe(true);
    expect(result.version).not.toBe(v1.version);
    // The empty restoration is a real commit recorded in the log.
    expect(vaultLog(dataDir).some((m) => /rollback grooming/.test(m))).toBe(true);
  });

  it("rolling back with no committed addendum is a safe no-op", () => {
    const { store } = s!;
    const result = store.rollbackAddendum("grooming");
    expect(result.restored).toBe(false);
    expect(result.version).toBeNull();
    expect(readJobAddendum(store, "grooming")).toEqual({ content: "", version: null });
  });

  it("rolls back ONLY the target job's addendum, leaving the other job untouched", () => {
    const { store } = s!;
    setJobAddendum(store, "intake", "intake v1");
    setJobAddendum(store, "intake", "intake v2");
    setJobAddendum(store, "grooming", "grooming v1");
    setJobAddendum(store, "grooming", "grooming v2");

    store.rollbackAddendum("grooming");

    expect(readJobAddendum(store, "grooming").content).toBe("grooming v1");
    expect(readJobAddendum(store, "intake").content).toBe("intake v2"); // untouched
  });
});
