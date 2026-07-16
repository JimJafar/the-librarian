// spec 065 T3 — memberProcedure + the fail-closed proof (SC 5, SC 6).
//
// SC 5: a `roles: ["member"]` principal receives UNAUTHORIZED from every admin-gated procedure,
// proven against the REAL routers for the named destructive set — including `restoreVault` WITH
// the CORRECT confirmation phrase (tRPC v11 runs adminProcedure's middleware BEFORE `.input()`
// parsing, so the role gate must fire first: UNAUTHORIZED, never BAD_REQUEST — the phrase must
// never be reachable before the role gate). Plus the two boundary pins: health stays public
// (pre-auth chrome depends on it), and `["member","admin"]` PASSES adminProcedure (admin is
// total authority; `member` never narrows it).
//
// SC 6: the memberProcedure tier itself — member passes, anonymous fails, admin passes.
//
// Mechanics per tests/trpc/principal.test.ts:100 (createCallerFactory with a non-admin caller).

import type { Principal } from "@librarian/core";
import { createLibrarianStore } from "@librarian/core";
import { appRouter, createCallerFactory } from "@librarian/mcp-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../test/helpers.js";
import { RESTORE_CONFIRMATION_PHRASE } from "../../dist/trpc/activity.js";
import type { TrpcContext } from "../../dist/trpc/context.js";
import { memberProcedure, router } from "../../dist/trpc/trpc.js";

const createCaller = createCallerFactory(appRouter);

const memberPrincipal: Principal = {
  kind: "member",
  actorId: "member:alice",
  roles: ["member"],
  attrs: { memberId: "alice" },
};

const adminPrincipal: Principal = { kind: "admin", actorId: "dashboard-admin", roles: ["admin"] };

const memberAndAdminPrincipal: Principal = {
  kind: "member",
  actorId: "member:lead",
  roles: ["member", "admin"],
};

const anonymousPrincipal: Principal = { kind: "agent", actorId: "anonymous", roles: [] };

function contextFor(principal: Principal, store: TrpcContext["store"]): TrpcContext {
  return {
    principal,
    role: principal.roles.includes("admin") ? "admin" : "anonymous",
    store,
    secretKey: null,
    adminToken: "",
  };
}

describe("spec 065 SC 5 — the destructive surface is shut to members (fail-closed)", () => {
  let dataDir = "";
  let store: ReturnType<typeof createLibrarianStore>;

  beforeEach(() => {
    dataDir = makeTempDir();
    store = createLibrarianStore({ dataDir });
  });
  afterEach(() => {
    store.close();
    cleanupTempDir(dataDir);
  });

  it("restoreVault WITH the correct confirmation phrase is UNAUTHORIZED — the role gate fires before input handling", async () => {
    const caller = createCaller(contextFor(memberPrincipal, store));
    // The CORRECT phrase and a well-formed hash: if input handling ran first this would be
    // BAD_REQUEST/NOT_FOUND (or worse, a restore); the role gate must make it UNAUTHORIZED.
    await expect(
      caller.activity.restoreVault({ hash: "abcdef1", confirm: RESTORE_CONFIRMATION_PHRASE }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("every named destructive procedure rejects a member with UNAUTHORIZED", async () => {
    const caller = createCaller(contextFor(memberPrincipal, store));
    const attempts: Array<{ name: string; call: () => Promise<unknown> }> = [
      { name: "vault.write", call: () => caller.vault.write({ path: "notes/a.md", raw: "x" }) },
      { name: "vault.delete", call: () => caller.vault.delete({ path: "notes/a.md" }) },
      {
        name: "vault.rename",
        call: () => caller.vault.rename({ from: "notes/a.md", to: "notes/b.md" }),
      },
      {
        name: "memories.update",
        call: () => caller.memories.update({ id: "mem-1", patch: { title: "t" } }),
      },
      { name: "memories.archive", call: () => caller.memories.archive({ id: "mem-1" }) },
      { name: "memories.purge", call: () => caller.memories.purge({ ids: ["mem-1"] }) },
      { name: "tokens.create", call: () => caller.tokens.create({ agentId: "agent-x" }) },
      { name: "tokens.revoke", call: () => caller.tokens.revoke({ id: "tok-1" }) },
      // The settings-family representative (grooming config mutation).
      { name: "grooming.setConfig", call: () => caller.grooming.setConfig({ enabled: false }) },
    ];
    for (const attempt of attempts) {
      await expect(attempt.call(), attempt.name).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
  });

  it("member writes stay shut: memories.create is UNAUTHORIZED (SC 8 — the slice is read-only in state)", async () => {
    const caller = createCaller(contextFor(memberPrincipal, store));
    await expect(
      caller.memories.create({ title: "t", content: "c" } as never),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("boundary pin: health.ping and health.info stay public — reachable by a role-less caller", async () => {
    const caller = createCaller(contextFor(anonymousPrincipal, store));
    await expect(caller.health.ping()).resolves.toEqual({ ok: true });
    // info is public too (pre-auth chrome renders the version badge); its release lookup is
    // fail-soft, so it resolves regardless of network.
    await expect(caller.health.info()).resolves.toMatchObject({ version: expect.any(String) });
  });

  it('boundary pin: a ["member","admin"] principal PASSES adminProcedure — admin is total authority', async () => {
    const caller = createCaller(contextFor(memberAndAdminPrincipal, store));
    await expect(caller.memories.list()).resolves.toBeDefined();
  });
});

describe("spec 065 SC 6 — the memberProcedure tier", () => {
  const probeRouter = router({ probe: memberProcedure.query(() => ({ reached: true as const })) });
  const callProbe = createCallerFactory(probeRouter);

  let dataDir = "";
  let store: ReturnType<typeof createLibrarianStore>;

  beforeEach(() => {
    dataDir = makeTempDir();
    store = createLibrarianStore({ dataDir });
  });
  afterEach(() => {
    store.close();
    cleanupTempDir(dataDir);
  });

  it("a member passes", async () => {
    const caller = callProbe(contextFor(memberPrincipal, store));
    await expect(caller.probe()).resolves.toEqual({ reached: true });
  });

  it("an admin passes (admin is a superset)", async () => {
    const caller = callProbe(contextFor(adminPrincipal, store));
    await expect(caller.probe()).resolves.toEqual({ reached: true });
  });

  it("an anonymous (role-less) principal fails with UNAUTHORIZED", async () => {
    const caller = callProbe(contextFor(anonymousPrincipal, store));
    await expect(caller.probe()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("an agent-role principal fails with UNAUTHORIZED (the tier admits member/admin only)", async () => {
    const agent: Principal = { kind: "agent", actorId: "some-agent", roles: ["agent"] };
    const caller = callProbe(contextFor(agent, store));
    await expect(caller.probe()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
