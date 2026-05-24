import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type HarnessLibrarianState,
  type StateLocation,
  loadState,
  saveState,
  StateIoError,
  StateLockError,
  stateFilePath,
  updateState,
  withStateLock,
} from "../src/state.js";

let baseDir: string;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-state-"));
});

afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
});

const loc: StateLocation = {
  harness: "claude-code",
  harnessSessionKey: "sess-1",
  cwd: "/home/jim/code/the-librarian",
  projectKey: "the-librarian",
};

function sample(over: Partial<HarnessLibrarianState> = {}): HarnessLibrarianState {
  return {
    version: 1,
    harness: "claude-code",
    harness_session_key: "sess-1",
    cwd: "/home/jim/code/the-librarian",
    project_key: "the-librarian",
    privacy: "public",
    ...over,
  };
}

describe("stateFilePath", () => {
  it("places files under baseDir/<harness>/<hash>.json", () => {
    const p = stateFilePath(loc, { baseDir });
    expect(p.startsWith(path.join(baseDir, "claude-code"))).toBe(true);
    expect(p.endsWith(".json")).toBe(true);
  });

  it("is stable for the same location and differs across locations", () => {
    expect(stateFilePath(loc, { baseDir })).toBe(stateFilePath(loc, { baseDir }));
    const other = stateFilePath({ ...loc, harnessSessionKey: "sess-2" }, { baseDir });
    expect(other).not.toBe(stateFilePath(loc, { baseDir }));
  });
});

describe("loadState / saveState", () => {
  it("round-trips state", () => {
    const state = sample({
      librarian_session_id: "ses_abc",
      last_activity_at: "2026-05-24T00:00:00.000Z",
    });
    saveState(state, { baseDir });
    expect(loadState(loc, { baseDir })).toEqual(state);
  });

  it("returns null when no state file exists", () => {
    expect(loadState(loc, { baseDir })).toBeNull();
  });

  it("throws StateIoError on corrupt JSON (fail closed, not silent)", () => {
    const p = stateFilePath(loc, { baseDir });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{ not json");
    expect(() => loadState(loc, { baseDir })).toThrow(StateIoError);
  });

  it("throws StateIoError on a structurally invalid state object", () => {
    const p = stateFilePath(loc, { baseDir });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ version: 99, harness: "claude-code" }));
    expect(() => loadState(loc, { baseDir })).toThrow(StateIoError);
  });
});

describe("permissions (§4.2)", () => {
  it("writes the state file 0600 and its directory 0700", () => {
    saveState(sample(), { baseDir });
    const p = stateFilePath(loc, { baseDir });
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(p)).mode & 0o777).toBe(0o700);
  });
});

describe("atomic writes (§9)", () => {
  it("leaves no temp files behind", () => {
    saveState(sample(), { baseDir });
    const dir = path.dirname(stateFilePath(loc, { baseDir }));
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("replaces existing state wholesale", () => {
    saveState(sample({ privacy: "public" }), { baseDir });
    saveState(sample({ privacy: "private", entered_private_at: "2026-05-24T01:00:00.000Z" }), {
      baseDir,
    });
    const loaded = loadState(loc, { baseDir });
    expect(loaded?.privacy).toBe("private");
    expect(loaded?.entered_private_at).toBe("2026-05-24T01:00:00.000Z");
  });
});

describe("withStateLock / updateState", () => {
  it("runs the mutator and persists the result", () => {
    const result = updateState(
      loc,
      (current) => {
        expect(current).toBeNull();
        return sample({ librarian_session_id: "ses_new" });
      },
      { baseDir },
    );
    expect(result.librarian_session_id).toBe("ses_new");
    expect(loadState(loc, { baseDir })?.librarian_session_id).toBe("ses_new");
  });

  it("read-modify-writes existing state under the lock", () => {
    saveState(sample({ privacy: "public" }), { baseDir });
    updateState(
      loc,
      (current) => ({
        ...current!,
        privacy: "private",
        entered_private_at: "2026-05-24T02:00:00.000Z",
      }),
      { baseDir },
    );
    expect(loadState(loc, { baseDir })?.privacy).toBe("private");
  });

  it("throws StateLockError when the lock is already held", () => {
    const lockPath = `${stateFilePath(loc, { baseDir })}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, String(process.pid));
    expect(() =>
      withStateLock(loc, () => "x", { baseDir, lockTimeoutMs: 0, lockStaleMs: 60_000 }),
    ).toThrow(StateLockError);
  });

  it("reclaims a stale lock", () => {
    const lockPath = `${stateFilePath(loc, { baseDir })}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "999999");
    const old = Date.now() / 1000 - 3600;
    fs.utimesSync(lockPath, old, old);
    const ran = withStateLock(loc, () => "ran", { baseDir, lockTimeoutMs: 0, lockStaleMs: 1000 });
    expect(ran).toBe("ran");
  });

  it("releases the lock after the function returns", () => {
    withStateLock(loc, () => "ok", { baseDir });
    const lockPath = `${stateFilePath(loc, { baseDir })}.lock`;
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("releases the lock even when the function throws", () => {
    expect(() =>
      withStateLock(
        loc,
        () => {
          throw new Error("boom");
        },
        { baseDir },
      ),
    ).toThrow("boom");
    const lockPath = `${stateFilePath(loc, { baseDir })}.lock`;
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("does not stomp a lock reclaimed by another holder on release (token check)", () => {
    // Simulate: while we hold the lock we outran staleMs, another process
    // reclaimed it and now holds it with its own token. Our release must
    // leave that new lock intact.
    const lockPath = `${stateFilePath(loc, { baseDir })}.lock`;
    withStateLock(
      loc,
      () => {
        fs.writeFileSync(lockPath, "other-holder-token");
      },
      { baseDir },
    );
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf8")).toBe("other-holder-token");
  });
});
