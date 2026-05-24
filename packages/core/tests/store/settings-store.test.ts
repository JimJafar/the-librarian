// Admin settings/secret store (memory-curator spec §7.1).
//
// A SQLite-authoritative key-value store for admin config. Secret values (the
// curator's LLM token) are encrypted at rest via secret-crypto and require the
// master key to read/write; plain values don't. `listSettings` returns metadata
// only — it must never leak a secret value.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LibrarianStore, createLibrarianStore, resolveSecretKey } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const KEY = resolveSecretKey("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");

interface Scope {
  store: LibrarianStore;
  dataDir: string;
}

function open(dataDir: string, withKey = true): LibrarianStore {
  return createLibrarianStore(withKey ? { dataDir, secretKey: KEY } : { dataDir });
}

function scope(): Scope {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-settings-"));
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

describe("settings store", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  it("round-trips a plain (non-secret) setting", () => {
    const { store } = s!;
    store.setSetting("curator.enabled", "true");
    expect(store.getSetting("curator.enabled")).toBe("true");
    expect(store.getSetting("missing")).toBeNull();
  });

  it("stores a secret value encrypted at rest and decrypts it on read", () => {
    const { store } = s!;
    const token = "dummy-llm-token-value-1234567890";
    store.setSetting("curator.llm_token", token, { secret: true });

    // Raw row must not contain the plaintext.
    const raw = store.db
      .prepare("SELECT value, is_secret FROM settings WHERE key = ?")
      .get("curator.llm_token") as { value: string; is_secret: number };
    expect(raw.is_secret).toBe(1);
    expect(raw.value).not.toContain(token);

    // Reading with the key decrypts.
    expect(store.getSetting("curator.llm_token")).toBe(token);
  });

  it("requires the master key to read or write a secret setting", () => {
    const { store, dataDir } = s!;
    store.setSetting("curator.llm_token", "dummy-secret", { secret: true });
    store.close();

    const noKey = open(dataDir, false);
    s!.store = noKey;
    expect(() => noKey.getSetting("curator.llm_token")).toThrow(/key/i);
    expect(() => noKey.setSetting("x", "y", { secret: true })).toThrow(/key/i);
    // plain settings still work without a key
    noKey.setSetting("curator.enabled", "false");
    expect(noKey.getSetting("curator.enabled")).toBe("false");
  });

  it("listSettings returns metadata only, never secret values", () => {
    const { store } = s!;
    store.setSetting("curator.enabled", "true");
    store.setSetting("curator.llm_token", "dummy-secret", { secret: true });
    const rows = store.listSettings();
    const tokenRow = rows.find((r) => r.key === "curator.llm_token");
    expect(tokenRow?.is_secret).toBe(true);
    // No `value` field on the listing shape at all.
    expect(JSON.stringify(rows)).not.toContain("dummy-secret");
  });

  it("updates and deletes settings", () => {
    const { store } = s!;
    store.setSetting("k", "v1");
    store.setSetting("k", "v2");
    expect(store.getSetting("k")).toBe("v2");
    store.deleteSetting("k");
    expect(store.getSetting("k")).toBeNull();
  });

  it("flips is_secret + encoding atomically when overwriting plain<->secret", () => {
    const { store } = s!;
    const rawOf = (key: string) =>
      store.db.prepare("SELECT value, is_secret FROM settings WHERE key = ?").get(key) as {
        value: string;
        is_secret: number;
      };

    // plain → secret: raw becomes ciphertext, flag set
    store.setSetting("k", "plainval");
    store.setSetting("k", "nowsecret-value", { secret: true });
    let raw = rawOf("k");
    expect(raw.is_secret).toBe(1);
    expect(raw.value).not.toContain("nowsecret-value");
    expect(store.getSetting("k")).toBe("nowsecret-value");

    // secret → plain: raw becomes plaintext, flag cleared
    store.setSetting("k", "backtoplain");
    raw = rawOf("k");
    expect(raw.is_secret).toBe(0);
    expect(raw.value).toBe("backtoplain");
    expect(store.getSetting("k")).toBe("backtoplain");
  });

  it("fails closed when reading a secret with the wrong master key", () => {
    const { store, dataDir } = s!;
    store.setSetting("curator.llm_token", "dummy-secret", { secret: true });
    store.close();

    const wrongKey = resolveSecretKey(
      "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100",
    );
    const reopened = createLibrarianStore({ dataDir, secretKey: wrongKey });
    s!.store = reopened;
    expect(() => reopened.getSetting("curator.llm_token")).toThrow();
  });

  it("survives a real schema-version bump (settings are authoritative)", () => {
    const { store, dataDir } = s!;
    store.setSetting("curator.llm_token", "dummy-secret", { secret: true });
    store.setSetting("curator.enabled", "true");
    store.db.exec("PRAGMA user_version = 9");
    store.close();

    const reopened = open(dataDir);
    s!.store = reopened;
    expect(reopened.getSetting("curator.enabled")).toBe("true");
    expect(reopened.getSetting("curator.llm_token")).toBe("dummy-secret");
  });
});
