// Spec 061 T3 — threading the caller Principal through tRPC (SC 5 + SC 6 dashboard half).
//
// SC 5: the REAL context factory (serving the internal listener, admin-by-isolation
// per ADR 0008 P3) resolves the trusted admin Principal, and `adminProcedure` gates on
// `principal.roles` — it admits an admin principal and rejects a non-admin one.
//
// SC 6 (dashboard half): a dashboard tRPC `memories.create` — driven through a context
// produced by the real factory, with NO explicit `agent_id` — records the principal's
// actor (`dashboard-admin`) in the PERSISTED frontmatter, asserted straight from the file
// (byte-identical to the reserved dashboard-admin actor the hardcode used to stamp).

import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { SYSTEM_ACTOR_IDS, createLibrarianStore } from "@librarian/core";
import { appRouter, createCallerFactory } from "@librarian/mcp-server";
import type { CreateHTTPContextOptions } from "@trpc/server/adapters/standalone";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../test/helpers.js";
import type { AuthConfig } from "../../dist/http/auth.js";
import { createContextFactory } from "../../dist/trpc/context.js";

const createCaller = createCallerFactory(appRouter);

// A minimal internal-surface AuthConfig: the internal listener resolves admin by
// isolation (ADR 0008 P3), so the default provider ignores the (absent) bearer.
function internalAuth(): AuthConfig {
  return {
    adminToken: "",
    agentToken: "",
    agentTokenMap: new Map(),
    allowedOrigins: [],
    allowNoAuth: true,
    host: "127.0.0.1",
    port: 0,
  };
}

// The internal surface ignores the request entirely, so a bare headers object suffices.
const fakeReq = { headers: {} } as unknown as IncomingMessage;
function factoryOpts(): CreateHTTPContextOptions {
  return { req: fakeReq } as unknown as CreateHTTPContextOptions;
}

// Read the sole written memory's `agent_id` STRAIGHT FROM THE FILE (SC 6 wants the
// persisted frontmatter, not a store read-back). Each test writes exactly one memory.
function soleMemoryAgentId(dataDir: string): string {
  const dir = path.join(dataDir, "vault", "memories");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  expect(files).toHaveLength(1);
  const raw = fs.readFileSync(path.join(dir, files[0]!), "utf8");
  const match = raw.match(/^agent_id:\s*(.+)$/m);
  if (!match) throw new Error(`no agent_id in frontmatter:\n${raw}`);
  return match[1]!.trim().replace(/^['"]|['"]$/g, "");
}

describe("spec 061 T3 — Principal threaded through tRPC", () => {
  let dataDir = "";
  beforeEach(() => {
    dataDir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dataDir);
  });

  it("SC 5 — the real context factory resolves the internal listener to the admin principal", () => {
    const store = createLibrarianStore({ dataDir });
    try {
      const ctx = createContextFactory({ store, auth: internalAuth(), secretKey: null })(
        factoryOpts(),
      );
      // The exact principal a procedure receives (shape test through the real factory).
      expect(ctx.principal).toEqual({
        kind: "admin",
        actorId: SYSTEM_ACTOR_IDS.dashboardAdmin,
        roles: ["admin"],
      });
      expect(ctx.principal.actorId).toBe("dashboard-admin");
      // The deprecated derived mirror stays consistent.
      expect(ctx.role).toBe("admin");
    } finally {
      store.close();
    }
  });

  it("SC 5 — adminProcedure ADMITS the admin principal (factory context)", async () => {
    const store = createLibrarianStore({ dataDir });
    try {
      const ctx = createContextFactory({ store, auth: internalAuth(), secretKey: null })(
        factoryOpts(),
      );
      const caller = createCaller(ctx);
      // An admin-gated query resolves — the procedure saw an admin principal.
      await expect(caller.memories.list()).resolves.toBeDefined();
    } finally {
      store.close();
    }
  });

  it("SC 5 — adminProcedure REJECTS a non-admin principal (UNAUTHORIZED)", async () => {
    const store = createLibrarianStore({ dataDir });
    try {
      // A non-internal surface isn't reachable through the factory (internal is always
      // admin), so this is a unit-level context carrying an agent-role principal.
      const caller = createCaller({
        principal: { kind: "agent", actorId: "some-agent", roles: ["agent"] },
        role: "anonymous",
        store,
        secretKey: null,
        adminToken: "",
      });
      await expect(caller.memories.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    } finally {
      store.close();
    }
  });

  it("SC 6 — a dashboard create attributes to the context principal (dashboard-admin) in the written file", async () => {
    const store = createLibrarianStore({ dataDir });
    try {
      const ctx = createContextFactory({ store, auth: internalAuth(), secretKey: null })(
        factoryOpts(),
      );
      // No explicit agent_id — the owner must derive from the principal's actor.
      await createCaller(ctx).memories.create({
        title: "Dashboard note",
        body: "Written through the admin dashboard.",
      });
    } finally {
      store.close();
    }
    expect(soleMemoryAgentId(dataDir)).toBe("dashboard-admin");
  });
});
