// Spec 070 T3: first-owner bootstrap claim redemption.
//
// The claim is a synchronous, one-shot ownership transition. These tests pin the
// refusal gates, effect ordering, and—most importantly—the two crash states:
// password-only remains claimable; enabled-but-unburned is already owned.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type BootstrapClaimHandle,
  type LibrarianStore,
  createBootstrapClaimHandle,
  createInertBootstrapClaimHandle,
  createLibrarianStore,
  getAuthConfig,
  mintBootstrapClaim,
  readBootstrapClaimBurn,
  resolveSecretKey,
  setEnabled,
  setOwnerPassword,
  verifyBootstrapClaimReceipt,
  verifyOwnerPassword,
} from "@librarian/core";
import { appRouter, createCallerFactory } from "@librarian/mcp-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const createCaller = createCallerFactory(appRouter);

const CLAIM_SECRET = "bootstrap-claim-secret-material-".repeat(2);
const KEY = resolveSecretKey("0011223344556677".repeat(4));
const EMAIL = "owner@example.com";
const PASSWORD = "correct-horse-battery";
const GENERIC_REFUSAL = "claim invalid, already used, or not armed";

let dataDir: string;
let store: LibrarianStore;
let bootstrapClaim: BootstrapClaimHandle;

function token(
  options: {
    email?: string;
    expiresAt?: Date;
    now?: Date;
    returnTo?: string;
  } = {},
): string {
  const now = options.now ?? new Date();
  return mintBootstrapClaim(
    CLAIM_SECRET,
    {
      email: options.email ?? EMAIL,
      expiresAt: options.expiresAt ?? new Date(now.getTime() + 15 * 60_000),
      ...(options.returnTo === undefined ? {} : { returnTo: options.returnTo }),
    },
    now,
  );
}

function caller(
  handle: BootstrapClaimHandle = bootstrapClaim,
  callerStore: LibrarianStore = store,
  secretKey: Buffer | null = KEY,
) {
  return createCaller({
    principal: { kind: "admin", actorId: "dashboard-admin", roles: ["admin"] },
    role: "admin",
    store: callerStore,
    secretKey,
    adminToken: "admin-token",
    bootstrapClaim: handle,
  });
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-bootstrap-claim-"));
  store = createLibrarianStore({ dataDir, secretKey: KEY });
  bootstrapClaim = createBootstrapClaimHandle({ dataDir, secret: CLAIM_SECRET });
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // already closed
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("auth.config bootstrap claim state", () => {
  it("reports claimPending exactly while an armed instance is unburned and disabled", async () => {
    expect((await caller(createInertBootstrapClaimHandle()).auth.config()).claimPending).toBe(
      false,
    );
    expect((await caller().auth.config()).claimPending).toBe(true);

    setOwnerPassword(store, EMAIL, PASSWORD);
    expect((await caller().auth.config()).claimPending).toBe(true);

    setEnabled(store, true);
    expect((await caller().auth.config()).claimPending).toBe(false);

    setEnabled(store, false);
    bootstrapClaim.burn(EMAIL);
    expect((await caller().auth.config()).claimPending).toBe(false);
  });
});

describe("auth.redeemBootstrapClaim", () => {
  it("sets the normalised token email, enables auth, burns last, and returns a receipt", async () => {
    const effects: string[] = [];
    const originalSetSetting = store.setSetting.bind(store);
    store.setSetting = (key, value, options) => {
      if (key === "auth:password") effects.push("password");
      if (key === "auth:enabled" && value === "true") effects.push("enabled");
      originalSetSetting(key, value, options);
    };
    const originalBurn = bootstrapClaim.burn;
    const recordingHandle: BootstrapClaimHandle = {
      ...bootstrapClaim,
      burn: (email, now) => {
        effects.push("burn");
        return originalBurn(email, now);
      },
    };
    const returnTo = "https://console.example.test/claimed?tenant=123";

    const result = await caller(recordingHandle).auth.redeemBootstrapClaim({
      token: token({ email: "Owner@Example.COM", returnTo }),
      password: PASSWORD,
    });

    expect(result).toMatchObject({
      ok: true,
      email: EMAIL,
      returnTo,
      receipt: expect.any(String),
      claimedAt: expect.any(String),
    });
    expect(effects).toEqual(["password", "enabled", "burn"]);
    expect(verifyOwnerPassword(store, EMAIL, PASSWORD)).toBe(true);
    expect(getAuthConfig(store, KEY).enabled).toBe(true);
    expect(readBootstrapClaimBurn(dataDir)).toMatchObject({ email: EMAIL });
    expect(verifyBootstrapClaimReceipt(CLAIM_SECRET, result.receipt)).toMatchObject({
      email: EMAIL,
      claimedAt: result.claimedAt,
    });
  });

  it("uses one generic refusal for unarmed, burned, enabled, and invalid-token gates", async () => {
    await expect(
      caller(createInertBootstrapClaimHandle()).auth.redeemBootstrapClaim({
        token: token(),
        password: PASSWORD,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: GENERIC_REFUSAL });

    bootstrapClaim.burn(EMAIL);
    await expect(
      caller().auth.redeemBootstrapClaim({ token: token(), password: PASSWORD }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: GENERIC_REFUSAL });

    fs.rmSync(path.join(dataDir, "bootstrap-claim.json"));
    setEnabled(store, true);
    await expect(
      caller().auth.redeemBootstrapClaim({ token: token(), password: PASSWORD }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: GENERIC_REFUSAL });

    setEnabled(store, false);
    await expect(
      caller().auth.redeemBootstrapClaim({ token: "not-a-claim", password: PASSWORD }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: GENERIC_REFUSAL });
  });

  it("checks burned and enabled gates before consulting the token", async () => {
    let verifies = 0;
    const countingHandle: BootstrapClaimHandle = {
      ...bootstrapClaim,
      verify: () => {
        verifies += 1;
        throw new Error("token verifier should not run");
      },
    };

    bootstrapClaim.burn(EMAIL);
    await expect(
      caller(countingHandle).auth.redeemBootstrapClaim({
        token: "not-a-claim",
        password: PASSWORD,
      }),
    ).rejects.toMatchObject({ message: GENERIC_REFUSAL });
    expect(verifies).toBe(0);

    fs.rmSync(path.join(dataDir, "bootstrap-claim.json"));
    setEnabled(store, true);
    await expect(
      caller(countingHandle).auth.redeemBootstrapClaim({
        token: "not-a-claim",
        password: PASSWORD,
      }),
    ).rejects.toMatchObject({ message: GENERIC_REFUSAL });
    expect(verifies).toBe(0);
  });

  it("discloses expiration without changing ownership state", async () => {
    const mintNow = new Date(Date.now() - 20 * 60_000);
    const expired = token({
      now: mintNow,
      expiresAt: new Date(mintNow.getTime() + 15 * 60_000),
    });

    await expect(
      caller().auth.redeemBootstrapClaim({ token: expired, password: PASSWORD }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: "claim expired" });
    expect(getAuthConfig(store, KEY).methods).toEqual([]);
    expect(bootstrapClaim.isBurned()).toBe(false);
  });

  it("rejects the password policy before any effect and leaves the token usable", async () => {
    const claimToken = token();

    await expect(
      caller().auth.redeemBootstrapClaim({ token: claimToken, password: "too-short" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "password must be at least 12 characters",
    });
    expect(getAuthConfig(store, KEY)).toMatchObject({ enabled: false, methods: [] });
    expect(bootstrapClaim.isBurned()).toBe(false);

    await expect(
      caller().auth.redeemBootstrapClaim({ token: claimToken, password: PASSWORD }),
    ).resolves.toMatchObject({ ok: true, email: EMAIL });
  });

  it("refuses an incomplete post-password config before changing the store", async () => {
    await expect(
      caller(bootstrapClaim, store, null).auth.redeemBootstrapClaim({
        token: token(),
        password: PASSWORD,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: GENERIC_REFUSAL });

    expect(getAuthConfig(store, null)).toMatchObject({ enabled: false, methods: [] });
    expect(bootstrapClaim.isBurned()).toBe(false);
  });

  it("keeps a password-only crash state claim-pending and allows re-redemption", async () => {
    const originalSetSetting = store.setSetting.bind(store);
    let crashOnEnable = true;
    store.setSetting = (key, value, options) => {
      if (crashOnEnable && key === "auth:enabled" && value === "true") {
        throw new Error("injected crash before enable");
      }
      originalSetSetting(key, value, options);
    };
    const claimToken = token();

    await expect(
      caller().auth.redeemBootstrapClaim({ token: claimToken, password: PASSWORD }),
    ).rejects.toThrow("injected crash before enable");
    expect(verifyOwnerPassword(store, EMAIL, PASSWORD)).toBe(true);
    expect(getAuthConfig(store, KEY).enabled).toBe(false);
    expect((await caller().auth.config()).claimPending).toBe(true);
    expect(bootstrapClaim.isBurned()).toBe(false);

    crashOnEnable = false;
    await expect(
      caller().auth.redeemBootstrapClaim({ token: claimToken, password: PASSWORD }),
    ).resolves.toMatchObject({ ok: true, email: EMAIL });
  });

  it("refuses every retry after a crash leaves auth enabled but unburned", async () => {
    const crashingHandle: BootstrapClaimHandle = {
      ...bootstrapClaim,
      burn: () => {
        throw new Error("injected crash before burn");
      },
    };
    const claimToken = token();

    await expect(
      caller(crashingHandle).auth.redeemBootstrapClaim({
        token: claimToken,
        password: PASSWORD,
      }),
    ).rejects.toThrow("injected crash before burn");
    expect(verifyOwnerPassword(store, EMAIL, PASSWORD)).toBe(true);
    expect(getAuthConfig(store, KEY).enabled).toBe(true);
    expect(bootstrapClaim.isBurned()).toBe(false);

    await expect(
      caller().auth.redeemBootstrapClaim({ token: claimToken, password: PASSWORD }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: GENERIC_REFUSAL });
  });

  it("allows only one of two racing redemptions to commit", async () => {
    const claimToken = token();
    const outcomes = await Promise.allSettled([
      caller().auth.redeemBootstrapClaim({ token: claimToken, password: PASSWORD }),
      caller().auth.redeemBootstrapClaim({ token: claimToken, password: PASSWORD }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(getAuthConfig(store, KEY).enabled).toBe(true);
    expect(bootstrapClaim.isBurned()).toBe(true);
  });
});
