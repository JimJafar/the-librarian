import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  createLibrarianStore,
  enableAuth,
  getAuthConfig,
  resolveSecretKey,
  setEnabled,
  setOAuth,
  setOwner,
  setOwnerPassword,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const KEY_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const OTHER_KEY = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

let dataDir: string;
let store: LibrarianStore;
const key = resolveSecretKey(KEY_HEX);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-authcfg-"));
  store = createLibrarianStore({ dataDir, secretKey: key });
});
afterEach(() => {
  try {
    store.close();
  } catch {
    // already closed
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("auth-config (D1.4)", () => {
  it("round-trips the enabled flag", () => {
    expect(getAuthConfig(store, key).enabled).toBe(false);
    setEnabled(store, true);
    expect(getAuthConfig(store, key).enabled).toBe(true);
    setEnabled(store, false);
    expect(getAuthConfig(store, key).enabled).toBe(false);
  });

  it("stores OAuth client secrets encrypted at rest and decrypts them on read", () => {
    setOAuth(store, "github", { clientId: "gh-id", clientSecret: "gh-client-secret" });
    const row = store.db
      .prepare("SELECT value, is_secret FROM settings WHERE key = ?")
      .get("auth:oauth:github") as { value: string; is_secret: number };
    expect(row.is_secret).toBe(1);
    expect(row.value).not.toContain("gh-client-secret"); // encrypted at rest

    const cfg = getAuthConfig(store, key);
    expect(cfg.oauth.github).toEqual({ clientId: "gh-id", clientSecret: "gh-client-secret" });
  });

  it("records configured methods and the OAuth owner allowlist", () => {
    setOwnerPassword(store, "owner", "correct-horse-battery");
    setOAuth(store, "google", { clientId: "g-id", clientSecret: "g-secret" });
    setOwner(store, "google", "owner@example.com");

    const cfg = getAuthConfig(store, key);
    expect(cfg.methods).toEqual(expect.arrayContaining(["password", "google"]));
    expect(cfg.methods).not.toContain("github");
    expect(cfg.password).toEqual({ username: "owner" });
    expect(cfg.ownerOAuth.google).toBe("owner@example.com");
  });

  it("never returns the password hash in the config", () => {
    setOwnerPassword(store, "owner", "correct-horse-battery");
    const row = store.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("auth:password") as { value: string };
    const hash = (JSON.parse(row.value) as { hash: string }).hash;
    const cfg = getAuthConfig(store, key);
    expect(JSON.stringify(cfg)).not.toContain(hash);
  });

  it("derives AUTH_SECRET stably per key, differently across keys, null without a key", () => {
    const a = getAuthConfig(store, key).authSecret;
    const b = getAuthConfig(store, key).authSecret;
    expect(a).toBeTruthy();
    expect(a).toBe(b); // stable for a given key
    expect(getAuthConfig(store, resolveSecretKey(OTHER_KEY)).authSecret).not.toBe(a); // changes with key
    expect(getAuthConfig(store, null).authSecret).toBeNull(); // no key → no derived secret
  });
});

describe("enableAuth (D1.5)", () => {
  const ADMIN = "libadmin_correct-admin-token";

  it("rejects a wrong or absent admin token and leaves the flag off", () => {
    setOwnerPassword(store, "owner", "correct-horse-battery");
    const wrong = enableAuth(store, {
      presentedAdminToken: "libadmin_wrong",
      expectedAdminToken: ADMIN,
      secretKey: key,
    });
    expect(wrong).toEqual({ ok: false, error: "bad_admin_token" });

    const absent = enableAuth(store, {
      presentedAdminToken: "",
      expectedAdminToken: ADMIN,
      secretKey: key,
    });
    expect(absent).toEqual({ ok: false, error: "bad_admin_token" });
    expect(getAuthConfig(store, key).enabled).toBe(false);
  });

  it("rejects an incomplete config (no usable method) before flipping the flag", () => {
    const r = enableAuth(store, {
      presentedAdminToken: ADMIN,
      expectedAdminToken: ADMIN,
      secretKey: key,
    });
    expect(r).toEqual({ ok: false, error: "incomplete" });
    expect(getAuthConfig(store, key).enabled).toBe(false);
  });

  it("rejects OAuth creds without an owner allowlist (would lock everyone out)", () => {
    setOAuth(store, "github", { clientId: "gh-id", clientSecret: "gh-secret" });
    const r = enableAuth(store, {
      presentedAdminToken: ADMIN,
      expectedAdminToken: ADMIN,
      secretKey: key,
    });
    expect(r).toEqual({ ok: false, error: "incomplete" });
    expect(getAuthConfig(store, key).enabled).toBe(false);
  });

  it("rejects when no master key is available (AUTH_SECRET underivable)", () => {
    setOwnerPassword(store, "owner", "correct-horse-battery");
    const r = enableAuth(store, {
      presentedAdminToken: ADMIN,
      expectedAdminToken: ADMIN,
      secretKey: null,
    });
    expect(r).toEqual({ ok: false, error: "incomplete" });
  });

  it("enables auth on a correct admin token + a complete password config", () => {
    setOwnerPassword(store, "owner", "correct-horse-battery");
    const r = enableAuth(store, {
      presentedAdminToken: ADMIN,
      expectedAdminToken: ADMIN,
      secretKey: key,
    });
    expect(r).toEqual({ ok: true });
    expect(getAuthConfig(store, key).enabled).toBe(true);
  });

  it("enables auth on a complete OAuth config (creds + owner allowlist)", () => {
    setOAuth(store, "google", { clientId: "g-id", clientSecret: "g-secret" });
    setOwner(store, "google", "owner@example.com");
    const r = enableAuth(store, {
      presentedAdminToken: ADMIN,
      expectedAdminToken: ADMIN,
      secretKey: key,
    });
    expect(r).toEqual({ ok: true });
    expect(getAuthConfig(store, key).enabled).toBe(true);
  });
});
