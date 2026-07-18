import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type BootstrapClaimHandle,
  type LibrarianStore,
  type Principal,
  createBootstrapClaimHandle,
  createInertBootstrapClaimHandle,
  createLibrarianStore,
  resolveSecretKey,
  setOwnerPassword,
} from "@librarian/core";
import { appRouter, createCallerFactory } from "@librarian/mcp-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TrpcContext } from "../../dist/trpc/context.js";
import { adminProcedure, memberProcedure, router } from "../../dist/trpc/trpc.js";

const createAppCaller = createCallerFactory(appRouter);
const probeRouter = router({
  adminProbe: adminProcedure.query(() => ({ reached: true as const })),
  memberProbe: memberProcedure.query(() => ({ reached: true as const })),
});
const createProbeCaller = createCallerFactory(probeRouter);

const KEY = resolveSecretKey("0011223344556677".repeat(4));
const OWNER = "owner";
const OWNER_PASSWORD = "correct-owner-password";
const PASSWORD_CANARY = ["password", "canary", "071"].join("-");
const WRONG_PASSWORD = "wrong-owner-password";
const ADMIN_TOKEN_CANARY = ["admin", "token", "canary", "071"].join("-");
const SETUP_TOKEN_CANARY = ["setup", "token", "canary", "071"].join("-");
const CLAIM_TOKEN_CANARY = ["claim", "token", "canary", "071"].join("-");
const CLAIM_SECRET = "bootstrap-claim-secret-material-".repeat(2);

let dataDir = "";
let store: LibrarianStore;
let bootstrapClaim: BootstrapClaimHandle;

function contextFor(
  principal: Principal,
  options: { adminToken?: string; claim?: BootstrapClaimHandle } = {},
): TrpcContext {
  return {
    principal,
    role: principal.roles.includes("admin") ? "admin" : "anonymous",
    store,
    secretKey: KEY,
    adminToken: options.adminToken ?? "expected-admin-token",
    bootstrapClaim: options.claim ?? bootstrapClaim,
  };
}

const adminPrincipal: Principal = {
  kind: "admin",
  actorId: "dashboard-admin",
  roles: ["admin"],
  tokenId: "tok-admin",
};

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-refusal-auth-"));
  store = createLibrarianStore({
    dataDir,
    secretKey: KEY,
    refusalLog: { armed: true },
  });
  bootstrapClaim = createBootstrapClaimHandle({ dataDir, secret: CLAIM_SECRET });
});

afterEach(() => {
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("tRPC authorization refusal evidence", () => {
  it("records principal fields and the exact procedure for admin and member guard denials", async () => {
    const member: Principal = {
      kind: "member",
      actorId: "member:alice",
      roles: ["member"],
      tokenId: "tok-member",
    };
    const anonymous: Principal = {
      kind: "agent",
      actorId: "anonymous",
      roles: [],
    };

    await expect(createProbeCaller(contextFor(member)).adminProbe()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(createProbeCaller(contextFor(anonymous)).memberProbe()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });

    const evidence = await store.readRefusals({ kind: "trpc-unauthorized" });
    expect(evidence.rows).toEqual([
      expect.objectContaining({
        kind: "trpc-unauthorized",
        surface: "internal",
        outcome: 401,
        procedure: "memberProbe",
        actorId: "anonymous",
        roles: [],
      }),
      expect.objectContaining({
        kind: "trpc-unauthorized",
        surface: "internal",
        outcome: 401,
        procedure: "adminProbe",
        actorId: "member:alice",
        roles: ["member"],
        tokenId: "tok-member",
      }),
    ]);
  });
});

describe("auth ceremony refusal evidence", () => {
  it("distinguishes password failure from lockout and redacts an unknown attempted username", async () => {
    setOwnerPassword(store, OWNER, OWNER_PASSWORD);
    const caller = createAppCaller(contextFor(adminPrincipal));

    await expect(
      caller.auth.verifyPassword({ username: PASSWORD_CANARY, password: PASSWORD_CANARY }),
    ).resolves.toMatchObject({ ok: false, locked: false });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await caller.auth.verifyPassword({ username: OWNER, password: WRONG_PASSWORD });
    }

    const evidence = await store.readRefusals();
    expect(evidence.rows[0]).toMatchObject({
      kind: "password-lockout",
      surface: "internal",
      outcome: "locked",
      username: OWNER,
      actorId: "dashboard-admin",
      roles: ["admin"],
      tokenId: "tok-admin",
    });
    expect(evidence.rows).toContainEqual(
      expect.objectContaining({
        kind: "password-failed",
        outcome: "refused",
        username: "<unknown-user>",
      }),
    );
    const serialised = fs.readFileSync(path.join(dataDir, "refusal-log.ndjson"), "utf8");
    expect(serialised).not.toContain(PASSWORD_CANARY);
    expect(serialised).not.toContain(WRONG_PASSWORD);
  });

  it("records setup-link, enable, and bootstrap-claim refusals without their presented tokens", async () => {
    setOwnerPassword(store, OWNER, OWNER_PASSWORD);
    const caller = createAppCaller(contextFor(adminPrincipal));

    await expect(
      caller.auth.redeemSetupLink({
        token: SETUP_TOKEN_CANARY,
        password: OWNER_PASSWORD,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      caller.auth.redeemBootstrapClaim({
        token: CLAIM_TOKEN_CANARY,
        password: OWNER_PASSWORD,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.auth.enable({ adminToken: ADMIN_TOKEN_CANARY })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });

    const evidence = await store.readRefusals();
    expect(evidence.rows.map((row) => row.kind)).toEqual([
      "enable-refused",
      "claim-refused",
      "setup-link-refused",
    ]);
    for (const row of evidence.rows) {
      expect(row).toMatchObject({
        surface: "internal",
        actorId: "dashboard-admin",
        roles: ["admin"],
        tokenId: "tok-admin",
      });
    }

    const serialised = fs.readFileSync(path.join(dataDir, "refusal-log.ndjson"), "utf8");
    for (const canary of [ADMIN_TOKEN_CANARY, SETUP_TOKEN_CANARY, CLAIM_TOKEN_CANARY]) {
      expect(serialised).not.toContain(canary);
    }
  });

  it("does not record successful password verification", async () => {
    setOwnerPassword(store, OWNER, OWNER_PASSWORD);
    const caller = createAppCaller(
      contextFor(adminPrincipal, { claim: createInertBootstrapClaimHandle() }),
    );

    await expect(
      caller.auth.verifyPassword({ username: OWNER, password: OWNER_PASSWORD }),
    ).resolves.toMatchObject({ ok: true, locked: false });
    expect(await store.readRefusals()).toEqual({ rows: [], total: 0, dropped: 0 });
  });
});
