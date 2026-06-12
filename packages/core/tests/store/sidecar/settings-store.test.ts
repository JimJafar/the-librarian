// JSON settings store tests (plan 036 Phase 2). Settings (incl. encrypted
// secrets) can't live in the git-pushed vault and aren't knowledge, so they
// move to a plain JSON file OUTSIDE the vault (decided 2026-06-01); the file
// holds AES-256-GCM ciphertext for secret values, never plaintext.
// The SettingsStore contract: plain + secret round-trip, metadata-only list,
// secrets need the master key, durable across reopen.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJsonSettingsStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
let filePath: string;
const KEY_A = Buffer.alloc(32, 7);
const KEY_B = Buffer.alloc(32, 9);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-settings-"));
  filePath = path.join(dir, "settings.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("JSON settings store", () => {
  it("round-trips a plain setting", () => {
    const store = createJsonSettingsStore({ filePath });
    store.setSetting("model", "gpt-5");
    expect(store.getSetting("model")).toBe("gpt-5");
    expect(store.getSetting("missing")).toBeNull();
  });

  it("round-trips a secret setting, storing only ciphertext on disk", () => {
    const store = createJsonSettingsStore({ filePath, secretKey: KEY_A });
    store.setSetting("llm_token", "sk-supersecret", { secret: true });
    expect(store.getSetting("llm_token")).toBe("sk-supersecret");
    // The plaintext must never hit disk.
    expect(fs.readFileSync(filePath, "utf8")).not.toContain("sk-supersecret");
  });

  it("throws when writing or reading a secret with no master key", () => {
    const store = createJsonSettingsStore({ filePath });
    expect(() => store.setSetting("t", "v", { secret: true })).toThrow(/master key/);
  });

  it("fails to read a secret written under a different key", () => {
    createJsonSettingsStore({ filePath, secretKey: KEY_A }).setSetting("t", "v", { secret: true });
    expect(() => createJsonSettingsStore({ filePath, secretKey: KEY_B }).getSetting("t")).toThrow();
  });

  it("listSettings returns metadata only (never values), sorted by key", () => {
    const store = createJsonSettingsStore({ filePath, secretKey: KEY_A });
    store.setSetting("zebra", "z");
    store.setSetting("alpha", "sk-x", { secret: true });
    const meta = store.listSettings();
    expect(meta.map((m) => m.key)).toEqual(["alpha", "zebra"]);
    expect(meta.find((m) => m.key === "alpha")?.is_secret).toBe(true);
    expect(JSON.stringify(meta)).not.toContain("sk-x");
    expect(meta.every((m) => !("value" in m))).toBe(true);
  });

  it("writes the secret-bearing file owner-only (no group/other access)", () => {
    const store = createJsonSettingsStore({ filePath, secretKey: KEY_A });
    store.setSetting("llm_token", "sk-x", { secret: true });
    expect(fs.statSync(filePath).mode & 0o077).toBe(0);
  });

  it("deletes a setting", () => {
    const store = createJsonSettingsStore({ filePath });
    store.setSetting("k", "v");
    store.deleteSetting("k");
    expect(store.getSetting("k")).toBeNull();
  });

  it("survives a reopen — the JSON file is the source of truth", () => {
    createJsonSettingsStore({ filePath, secretKey: KEY_A }).setSetting("llm_token", "sk-1", {
      secret: true,
    });
    const reopened = createJsonSettingsStore({ filePath, secretKey: KEY_A });
    expect(reopened.getSetting("llm_token")).toBe("sk-1");
  });
});
