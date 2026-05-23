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
import { handleMcpPayload } from "@librarian/mcp-server";
import { describe, expect, it } from "vitest";
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
});
