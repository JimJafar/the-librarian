// Spec 061 T2 — threading the caller Principal through MCP (SC 4 + SC 6, MCP half).
//
// Pins the load-bearing SC 4 rule at the `scopeAgentArgs` chokepoint: only a
// principal's CRYPTOGRAPHIC binding (`boundActorId`) is `resolveCaller`'s
// `authenticatedAgentId`, while `actorId` is the no-id fallback ONLY. That split is
// what lets an unbound (sentinel) single-token caller self-identify via a body
// `agent_id` without tripping the impersonation guard — the exact v1-draft failure
// mode — while a bound (map/DB) token still rejects a mismatched body id.
//
// SC 6 (MCP half) is asserted end-to-end from the WRITTEN FILE: a bound-token
// remember records the bound id in frontmatter, and — the one signed-off,
// OSS-visible attribution change (SC 3) — an env-token remember with no body id now
// records the `env-token-agent` sentinel where it used to record `unknown-agent`.

import fs from "node:fs";
import path from "node:path";
import { type LibrarianStore, type Principal, SENTINEL_ACTOR_IDS } from "@librarian/core";
import { handleMcpPayload, logger } from "@librarian/mcp-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withStore } from "../../../../test/helpers.js";

interface CallResponse {
  error?: { message: string };
}

function remember(
  store: LibrarianStore,
  args: Record<string, unknown>,
  principal: Principal,
): Promise<CallResponse> {
  return handleMcpPayload(
    store,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "remember", arguments: args } },
    { principal },
  ) as unknown as Promise<CallResponse>;
}

function rememberArgs(title: string, agent_id?: string): Record<string, unknown> {
  return {
    ...(agent_id === undefined ? {} : { agent_id }),
    title,
    body: "Body text for the principal-threading test.",
    category: "tools",
    visibility: "common",
    scope: "global",
  };
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

// An env single-token caller: authenticated but bound to NOBODY — the sentinel
// actorId, no boundActorId (spec 061 SC 1). A body `agent_id` must win for it.
const envTokenPrincipal: Principal = {
  kind: "agent",
  actorId: SENTINEL_ACTOR_IDS.envToken,
  roles: ["agent"],
  scope: "agent",
};

// A map/DB-token caller: a CRYPTOGRAPHIC binding — the id is both actorId and boundActorId.
function boundPrincipal(id: string): Principal {
  return { kind: "agent", actorId: id, boundActorId: id, roles: ["agent"], scope: "agent" };
}

describe("spec 061 T2 — Principal threading through MCP (SC 4 regression pair)", () => {
  // Test 4 legitimately trips the soft-migration missing-identity warning; silence
  // (and capture) it for the whole suite so NDJSON noise doesn't leak and the shared
  // module-level logger doesn't bleed across tests.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("single-token (env) caller + body agent_id resolves to the body id — NO throw (sentinel never binds)", async () => {
    await withStore(async (store: LibrarianStore, dataDir: string) => {
      const res = await remember(
        store,
        rememberArgs("Env self-id", "claude-code"),
        envTokenPrincipal,
      );
      expect(res.error).toBeFalsy();
      // The body id wins because the env sentinel carries no boundActorId, so the
      // impersonation guard never runs (the v1-draft failure mode, pinned).
      expect(soleMemoryAgentId(dataDir)).toBe("claude-code");
    });
  });

  it("map-token (bound) caller + MISMATCHED body agent_id still throws (guard intact)", async () => {
    await withStore(async (store: LibrarianStore) => {
      const res = await remember(
        store,
        rememberArgs("Impersonation", "guybrush"),
        boundPrincipal("codex"),
      );
      expect(res.error).toBeTruthy();
      expect(res.error?.message).toMatch(/match|impersonat|mismatch/i);
    });
  });
});

describe("spec 061 T2 — end-to-end provenance from the written file (SC 6, MCP half)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("a map-token remember records the token's BOUND id in frontmatter", async () => {
    await withStore(async (store: LibrarianStore, dataDir: string) => {
      const res = await remember(store, rememberArgs("Bound provenance"), boundPrincipal("claude"));
      expect(res.error).toBeFalsy();
      expect(soleMemoryAgentId(dataDir)).toBe("claude");
    });
  });

  it("an env-token remember with NO body id records the `env-token-agent` sentinel (the signed-off change)", async () => {
    await withStore(async (store: LibrarianStore, dataDir: string) => {
      const res = await remember(store, rememberArgs("Sentinel provenance"), envTokenPrincipal);
      expect(res.error).toBeFalsy();
      // The visible proof of SC 3: where this write used to land `unknown-agent`, it now
      // lands the documented sentinel — read back off the persisted frontmatter.
      expect(soleMemoryAgentId(dataDir)).toBe(SENTINEL_ACTOR_IDS.envToken);
      // The soft-migration warning names the SAME sentinel it will persist, not a stale constant.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({
        tool: "remember",
        actor_id: SENTINEL_ACTOR_IDS.envToken,
      });
    });
  });

  it("an env-token remember WITH a body id records the body id (unchanged behaviour)", async () => {
    await withStore(async (store: LibrarianStore, dataDir: string) => {
      const res = await remember(store, rememberArgs("Env named", "hermes"), envTokenPrincipal);
      expect(res.error).toBeFalsy();
      expect(soleMemoryAgentId(dataDir)).toBe("hermes");
    });
  });

  it("an UNBOUND principal's non-canonical actorId is CANONICALISED in frontmatter (fix 4): member:sarah → member-sarah", async () => {
    // A member-aware provider recommends a raw `member:sarah` actorId with NO boundActorId (unbound
    // — the docs-recommended shape). With no body id it is the fallback, and must canonicalise the
    // SAME way every agent_id write does, not split off a second `member:sarah` actor.
    const unboundMember: Principal = {
      kind: "member",
      actorId: "member:sarah",
      roles: ["agent"],
      scope: "agent",
    };
    await withStore(async (store: LibrarianStore, dataDir: string) => {
      const res = await remember(store, rememberArgs("Unbound member note"), unboundMember);
      expect(res.error).toBeFalsy();
      expect(soleMemoryAgentId(dataDir)).toBe("member-sarah");
    });
  });

  it("a stdio-style no-id principal records the `local-agent` sentinel (SC 3, fix 7)", async () => {
    // The shape resolveStdioPrincipal yields for a no-id stdio caller: the localhost sentinel,
    // agent role, NO boundActorId. With no body id it lands the documented sentinel in frontmatter.
    const localAgent: Principal = {
      kind: "agent",
      actorId: SENTINEL_ACTOR_IDS.localhost,
      roles: ["agent"],
      scope: "agent",
    };
    await withStore(async (store: LibrarianStore, dataDir: string) => {
      const res = await remember(store, rememberArgs("Local provenance"), localAgent);
      expect(res.error).toBeFalsy();
      expect(soleMemoryAgentId(dataDir)).toBe(SENTINEL_ACTOR_IDS.localhost);
    });
  });

  it("a stdio-style no-id principal WITH a body id records the body id (fix 7 — body wins)", async () => {
    const localAgent: Principal = {
      kind: "agent",
      actorId: SENTINEL_ACTOR_IDS.localhost,
      roles: ["agent"],
      scope: "agent",
    };
    await withStore(async (store: LibrarianStore, dataDir: string) => {
      const res = await remember(store, rememberArgs("Local named", "guybrush"), localAgent);
      expect(res.error).toBeFalsy();
      expect(soleMemoryAgentId(dataDir)).toBe("guybrush");
    });
  });
});
