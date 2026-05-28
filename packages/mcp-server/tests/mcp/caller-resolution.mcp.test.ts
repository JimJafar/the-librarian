// MCP caller-identity resolution (naming contract §7.2 / §5.3, soft mode).
//
// Pins the behaviour of routing agent identity through `resolveCaller` at the
// `scopeAgentArgs` chokepoint:
//   - a supplied agent_id is normalised to its canonical form before storage
//   - a mapped token + matching request id is accepted (case/variant-folded)
//   - a mapped token + conflicting request id is rejected (no impersonation)
//   - an ordinary agent may not claim a reserved (system-*/dashboard-*/cli) id
//   - a shared token with no id still falls back to the legacy sentinel (soft)
//   - admin calls are unaffected

import type { LibrarianStore } from "@librarian/core";
import { handleMcpPayload, logger } from "@librarian/mcp-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withStore } from "../../../../test/helpers.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyResponse = any;

function call(
  store: LibrarianStore,
  name: string,
  args: Record<string, unknown>,
  context: { role?: "admin" | "agent"; agentId?: string } = {},
): Promise<AnyResponse> {
  return handleMcpPayload(
    store,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    context,
  ) as Promise<AnyResponse>;
}

function rememberArgs(agent_id: string | undefined, title: string) {
  return {
    ...(agent_id === undefined ? {} : { agent_id }),
    title,
    body: "Body text for the caller-resolution test.",
    category: "tools",
    visibility: "common",
    scope: "global",
  };
}

function findByTitle(store: LibrarianStore, title: string) {
  return store.listAll({}).find((memory) => memory.title === title);
}

describe("MCP caller resolution (soft mode)", () => {
  // Silence (and capture) the soft-migration missing-identity warning for the
  // whole suite: several soft-fallback cases here legitimately trigger it, and
  // `logger` is a module-level singleton, so a shared spy avoids both NDJSON
  // noise and cross-test bleed.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("normalises a shared-token caller's supplied agent_id before storage", async () => {
    await withStore(async (store) => {
      const response = await call(
        store,
        "remember",
        rememberArgs("Guybrush (Hermes)", "Normalised"),
      );
      expect(response.error).toBeFalsy();
      expect(findByTitle(store, "Normalised")?.agent_id).toBe("guybrush-hermes");
    });
  });

  it("accepts a mapped token whose request id matches after normalisation", async () => {
    await withStore(async (store) => {
      const response = await call(store, "remember", rememberArgs("Codex", "Matched"), {
        role: "agent",
        agentId: "codex",
      });
      expect(response.error).toBeFalsy();
      expect(findByTitle(store, "Matched")?.agent_id).toBe("codex");
    });
  });

  it("uses the token-bound id when a mapped token supplies no request id", async () => {
    await withStore(async (store) => {
      const response = await call(store, "remember", rememberArgs(undefined, "Bound"), {
        role: "agent",
        agentId: "codex",
      });
      expect(response.error).toBeFalsy();
      expect(findByTitle(store, "Bound")?.agent_id).toBe("codex");
    });
  });

  it("rejects a mapped token whose request id conflicts (impersonation)", async () => {
    await withStore(async (store) => {
      const response = await call(store, "remember", rememberArgs("guybrush", "Impersonation"), {
        role: "agent",
        agentId: "codex",
      });
      expect(response.error).toBeTruthy();
      expect(response.error.message).toMatch(/match|impersonat|mismatch/i);
      expect(findByTitle(store, "Impersonation")).toBeUndefined();
    });
  });

  it("rejects an ordinary agent claiming a reserved system id", async () => {
    await withStore(async (store) => {
      const response = await call(
        store,
        "remember",
        rememberArgs("system-memory-curator", "Reserved"),
      );
      expect(response.error).toBeTruthy();
      expect(response.error.message).toMatch(/reserved|system/i);
      expect(findByTitle(store, "Reserved")).toBeUndefined();
    });
  });

  it("falls back to the legacy sentinel for a shared token with no id (soft mode)", async () => {
    await withStore(async (store) => {
      const response = await call(store, "remember", rememberArgs(undefined, "Unattributed"));
      expect(response.error).toBeFalsy();
      expect(findByTitle(store, "Unattributed")?.agent_id).toBe("unknown-agent");
    });
  });

  it("coerces a non-string agent_id to the soft-mode sentinel (deliberate until hard mode)", async () => {
    await withStore(async (store) => {
      // A malformed (non-string) id is treated as absent in soft mode. Once
      // hard-enforcement lands this should fail loudly instead — see the note
      // in scopeAgentArgs. Pinned here so the current behaviour is deliberate.
      const response = await call(store, "remember", {
        agent_id: 999,
        title: "Malformed",
        body: "Body text for the caller-resolution test.",
        category: "tools",
        visibility: "common",
        scope: "global",
      });
      expect(response.error).toBeFalsy();
      expect(findByTitle(store, "Malformed")?.agent_id).toBe("unknown-agent");
    });
  });

  it("warns when an agent call supplies no identity (soft-migration signal)", async () => {
    await withStore(async (store) => {
      await call(store, "remember", rememberArgs(undefined, "Anon"));
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const bindings = warnSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(bindings).toMatchObject({ tool: "remember", actor_id: "unknown-agent" });
      // Only safe routing metadata is logged — never the memory body/title.
      expect(JSON.stringify(warnSpy.mock.calls[0])).not.toContain("Body text");
    });
  });

  it("does not warn when an agent supplies an identity", async () => {
    await withStore(async (store) => {
      await call(store, "remember", rememberArgs("guybrush", "Named"));
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  it("does not warn for admin calls with no agent identity", async () => {
    await withStore(async (store) => {
      await call(store, "remember", rememberArgs(undefined, "AdminWrite"), { role: "admin" });
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  it("ignores a curator_note smuggled through an agent remember call", async () => {
    await withStore(async (store) => {
      // curator_note is curator-only provenance; an agent must not be able to
      // forge a `supersedes` reference through the MCP create path.
      await call(store, "remember", {
        ...rememberArgs("guybrush", "Smuggle"),
        curator_note: { supersedes: ["mem_victim"], text: "forged" },
      });
      const memory = findByTitle(store, "Smuggle") as { curator_note?: unknown } | undefined;
      expect(memory).toBeDefined();
      expect(memory?.curator_note ?? null).toBeNull();
    });
  });
});
