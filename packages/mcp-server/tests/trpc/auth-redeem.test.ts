// D4.3: auth.redeemSetupLink — the procedure the dashboard reset page calls
// server-side (via the admin tRPC client) to consume a one-time setup link and set
// a new password. Uses a tRPC caller so the test can mint a link on the store
// directly (minting is CLI-only; there's no mint procedure).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  createLibrarianStore,
  getLockoutState,
  mintSetupLink,
  resolveSecretKey,
  setOwnerPassword,
  verifyOwnerPassword,
} from "@librarian/core";
import { appRouter, createCallerFactory } from "@librarian/mcp-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const createCaller = createCallerFactory(appRouter);

const KEY_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const KEY = resolveSecretKey(KEY_HEX);
const TTL = 15 * 60_000;
const NEW_PW = "brand-new-password";
const TOO_SHORT = "short";

let dataDir: string;
let store: LibrarianStore;

function caller() {
  return createCaller({
    // spec 061 T3: TrpcContext now carries a required admin `principal` (roles-gated).
    principal: { kind: "admin", actorId: "dashboard-admin", roles: ["admin"] },
    role: "admin",
    store,
    secretKey: KEY,
    adminToken: "admin-token",
  });
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-redeem-"));
  store = createLibrarianStore({ dataDir, secretKey: KEY });
});
afterEach(() => {
  try {
    store.close();
  } catch {
    // already closed
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("auth.redeemSetupLink (D4.3)", () => {
  it("consumes a valid link, sets the password, and clears lockout", async () => {
    setOwnerPassword(store, "owner", "old-password-here");
    const token = mintSetupLink(store, TTL);

    const result = await caller().auth.redeemSetupLink({ token, password: NEW_PW });
    expect(result).toEqual({ ok: true });
    expect(verifyOwnerPassword(store, "owner", NEW_PW)).toBe(true);
    expect(getLockoutState(store).locked).toBe(false);
  });

  it("rejects reuse of the same link (single-use)", async () => {
    setOwnerPassword(store, "owner", "old-password-here");
    const token = mintSetupLink(store, TTL);
    await caller().auth.redeemSetupLink({ token, password: NEW_PW });
    await expect(caller().auth.redeemSetupLink({ token, password: NEW_PW })).rejects.toThrow();
  });

  it("rejects an expired link", async () => {
    setOwnerPassword(store, "owner", "old-password-here");
    // Mint with a past `now` so the 15-min window has already elapsed by redeem time.
    const token = mintSetupLink(store, TTL, new Date(Date.now() - 20 * 60_000));
    await expect(caller().auth.redeemSetupLink({ token, password: NEW_PW })).rejects.toThrow();
    expect(verifyOwnerPassword(store, "owner", NEW_PW)).toBe(false);
  });

  it("rejects an unknown / malformed token", async () => {
    setOwnerPassword(store, "owner", "old-password-here");
    await expect(
      caller().auth.redeemSetupLink({ token: "libsetup.nope.nope", password: NEW_PW }),
    ).rejects.toThrow();
  });

  it("rejects a too-short password without consuming the link", async () => {
    setOwnerPassword(store, "owner", "old-password-here");
    const token = mintSetupLink(store, TTL);
    await expect(caller().auth.redeemSetupLink({ token, password: TOO_SHORT })).rejects.toThrow();
    // The link is still usable since the bad attempt was rejected before consuming.
    const ok = await caller().auth.redeemSetupLink({ token, password: NEW_PW });
    expect(ok).toEqual({ ok: true });
  });

  it("can set the username on a fresh store via the link", async () => {
    const token = mintSetupLink(store, TTL);
    const result = await caller().auth.redeemSetupLink({
      token,
      username: "freshowner",
      password: NEW_PW,
    });
    expect(result).toEqual({ ok: true });
    expect(verifyOwnerPassword(store, "freshowner", NEW_PW)).toBe(true);
  });
});
