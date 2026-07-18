import { AuditEventSchema, type Principal, createLibrarianStore } from "@librarian/core";
import { appRouter, createCallerFactory } from "@librarian/mcp-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../test/helpers.js";
import type { ActorDisplayProvider } from "../../dist/plugin.js";
import { resolveActorDisplays } from "../../dist/trpc/actor-displays.js";
import type { TrpcContext } from "../../dist/trpc/context.js";

const createCaller = createCallerFactory(appRouter);
const admin: Principal = {
  kind: "admin",
  actorId: "dashboard-admin",
  roles: ["admin"],
};
const dataDirs: string[] = [];
const stores: ReturnType<typeof createLibrarianStore>[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dataDir of dataDirs.splice(0)) cleanupTempDir(dataDir);
});

function freshStore(): ReturnType<typeof createLibrarianStore> {
  const dataDir = makeTempDir();
  dataDirs.push(dataDir);
  const store = createLibrarianStore({ dataDir });
  stores.push(store);
  return store;
}

function contextFor(
  store: TrpcContext["store"],
  actorDisplayProvider?: ActorDisplayProvider,
): TrpcContext {
  return {
    principal: admin,
    role: "admin",
    store,
    secretKey: null,
    adminToken: "",
    ...(actorDisplayProvider ? { actorDisplayProvider } : {}),
  };
}

describe("actor display response mapping (spec 068)", () => {
  it("batches unique ids once, sanitises names, caps them, and uses prototype-safe keys", () => {
    const resolveActorDisplaysSpy = vi.fn((ids: readonly string[]) => {
      expect(ids).toEqual(["actor-a", "constructor", "empty"]);
      return new Map([
        ["actor-a", `A\u0000li\u001fce\u007f\u202e\u2069${"x".repeat(80)}`],
        ["constructor", "Constructor Person"],
        ["empty", "\u0000\u202e"],
        ["not-in-payload", "Must not escape scope"],
      ]);
    });
    const provider: ActorDisplayProvider = {
      resolveActorDisplays: resolveActorDisplaysSpy,
    };

    const result = resolveActorDisplays(provider, ["actor-a", "constructor", "actor-a", "empty"]);

    expect(resolveActorDisplaysSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      "actor-a": `Alice${"x".repeat(59)}`,
      constructor: "Constructor Person",
    });
    expect(Object.hasOwn(result!, "constructor")).toBe(true);
    expect(Object.hasOwn(result!, "not-in-payload")).toBe(false);
  });

  it("skips the provider for an empty id set and omits an empty result", () => {
    const resolveActorDisplaysSpy = vi.fn(() => new Map<string, string>());
    const provider: ActorDisplayProvider = {
      resolveActorDisplays: resolveActorDisplaysSpy,
    };

    expect(resolveActorDisplays(provider, [])).toBeUndefined();
    expect(resolveActorDisplays(provider, ["unknown"])).toBeUndefined();
    expect(resolveActorDisplaysSpy).toHaveBeenCalledTimes(1);
  });

  it("fails soft when optional display resolution throws", () => {
    const provider: ActorDisplayProvider = {
      resolveActorDisplays: () => {
        throw new Error("directory unavailable");
      },
    };

    expect(resolveActorDisplays(provider, ["actor-a"])).toBeUndefined();
  });

  it("keeps strict audit rows intact and places resolved names on the page envelope", async () => {
    const store = freshStore();
    store.createMemory(
      { title: "Auditable", body: "Body", agent_id: "owner" },
      { audit_actor_id: "actor-a" },
    );
    const resolveActorDisplaysSpy = vi.fn(
      (ids: readonly string[]) => new Map(ids.map((id) => [id, `Display ${id}`])),
    );
    const provider: ActorDisplayProvider = {
      resolveActorDisplays: resolveActorDisplaysSpy,
    };

    const page = await createCaller(contextFor(store, provider)).activity.auditExport();

    expect(resolveActorDisplaysSpy).toHaveBeenCalledTimes(1);
    const visibleIds = [
      ...new Set(page.events.flatMap((event) => (event.actor ? [event.actor] : []))),
    ];
    expect(resolveActorDisplaysSpy).toHaveBeenCalledWith(visibleIds);
    expect(Object.keys(page.actorDisplays ?? {}).sort()).toEqual([...visibleIds].sort());
    for (const event of page.events) expect(() => AuditEventSchema.parse(event)).not.toThrow();
  });

  it("keeps audit and proposal payloads unchanged when no provider is configured", async () => {
    const store = freshStore();
    store.createMemory(
      { title: "Proposal", body: "Body", agent_id: "actor-a" },
      { requires_approval: true },
    );
    const caller = createCaller(contextFor(store));

    const auditPage = await caller.activity.auditExport();
    expect(auditPage).toEqual(store.exportAudit(admin));
    expect(Object.hasOwn(auditPage, "actorDisplays")).toBe(false);

    const rows = await caller.memories.proposalsForReview();
    expect(rows).toHaveLength(1);
    expect(Object.hasOwn(rows[0]!, "actorDisplay")).toBe(false);
  });

  it("adds a sanitised row-level display to proposals without replacing the actor id", async () => {
    const store = freshStore();
    store.createMemory(
      { title: "Proposal", body: "Body", agent_id: "actor-a" },
      { requires_approval: true },
    );
    const resolveActorDisplaysSpy = vi.fn(() => new Map([["actor-a", "Alice\u202e\u0000 Member"]]));
    const provider: ActorDisplayProvider = {
      resolveActorDisplays: resolveActorDisplaysSpy,
    };

    const rows = await createCaller(contextFor(store, provider)).memories.proposalsForReview();

    expect(resolveActorDisplaysSpy).toHaveBeenCalledOnce();
    expect(resolveActorDisplaysSpy).toHaveBeenCalledWith(["actor-a"]);
    expect(rows[0]?.proposal.agent_id).toBe("actor-a");
    expect(rows[0]?.actorDisplay).toBe("Alice Member");
  });
});
