// T3.1 — `remember` reads conv_state and server-sets `domain`.
//
// Branches per spec §4.10 + §4.14:
//   - conv_id present + matching conv_state → memory carries
//     conv_state.domain.
//   - conv_id present but no conv_state row → outside-session: status
//     proposed, domain NULL, requires_approval=true.
//   - conv_id absent (no routing signal at all) → outside-session
//     same shape. PR 5 starts injecting conv_id from hook context.
//   - Single-domain installs (the §4.10 fast path) bypass the outside-
//     session route entirely: the sole domain is auto-assigned. The
//     outside-session tests below add a second domain so the fast path
//     doesn't fire.
//
// Also pins: caller-supplied `domain` / `is_global` / `requires_approval`
// in the input are silently ignored, matching spec §4.1–§4.4.

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
): Promise<AnyResponse> {
  return handleMcpPayload(
    store,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    { role: "agent", agentId: "codex" },
  ) as Promise<AnyResponse>;
}

function lastMemory(store: LibrarianStore): {
  domain: string | null;
  is_global: number;
  requires_approval: number;
  status: string;
} {
  return store.db
    .prepare(
      "SELECT domain, is_global, requires_approval, status FROM memories ORDER BY created_at DESC LIMIT 1",
    )
    .get() as {
    domain: string | null;
    is_global: number;
    requires_approval: number;
    status: string;
  };
}

describe("MCP remember + conv_state (T3.1)", () => {
  it("in-conversation write picks up conv_state.domain", async () => {
    await withStore(async (store) => {
      store.convState.upsert("claude:coding", {
        harness: "claude-code",
        domain: "coding",
      });
      await call(store, "remember", {
        agent_id: "codex",
        title: "use pnpm",
        body: "this repo uses pnpm not npm",
        category: "tools",
        conv_id: "claude:coding",
      });
      const row = lastMemory(store);
      expect(row.domain).toBe("coding");
      expect(row.status).toBe("active");
      expect(row.requires_approval).toBe(0);
    });
  });

  it("outside-session write (no conv_id) routes to proposal with domain=NULL once the install is multi-domain", async () => {
    await withStore(async (store) => {
      store.db
        .prepare("INSERT INTO domains (name, created_at) VALUES (?, ?)")
        .run("coding", new Date().toISOString());
      await call(store, "remember", {
        agent_id: "codex",
        title: "outside note",
        body: "no conversation context here",
        category: "tools",
      });
      const row = lastMemory(store);
      expect(row.domain).toBeNull();
      expect(row.requires_approval).toBe(1);
      expect(row.status).toBe("proposed");
    });
  });

  it("conv_id present but no conv_state row is treated as outside-session", async () => {
    await withStore(async (store) => {
      store.db
        .prepare("INSERT INTO domains (name, created_at) VALUES (?, ?)")
        .run("coding", new Date().toISOString());
      await call(store, "remember", {
        agent_id: "codex",
        title: "stray id",
        body: "harness sent a conv_id but no one upserted",
        category: "tools",
        conv_id: "claude:dangling",
      });
      const row = lastMemory(store);
      expect(row.domain).toBeNull();
      expect(row.requires_approval).toBe(1);
      expect(row.status).toBe("proposed");
    });
  });

  it("single-domain install assigns the sole domain without prompting (§4.10 fast path)", async () => {
    await withStore(async (store) => {
      // Default install has only `general`.
      await call(store, "remember", {
        agent_id: "codex",
        title: "single-domain note",
        body: "no conv_id but only one domain exists",
        category: "tools",
      });
      const row = lastMemory(store);
      expect(row.domain).toBe("general");
      expect(row.status).toBe("active");
    });
  });

  it("caller-supplied domain / is_global / requires_approval are ignored", async () => {
    await withStore(async (store) => {
      store.convState.upsert("claude:coding", {
        harness: "claude-code",
        domain: "coding",
      });
      await call(store, "remember", {
        agent_id: "codex",
        title: "spoofed",
        body: "agent tries to set everything",
        category: "tools",
        conv_id: "claude:coding",
        domain: "family-admin",
        is_global: true,
        requires_approval: false,
      });
      const row = lastMemory(store);
      expect(row.domain).toBe("coding");
      expect(row.is_global).toBe(0);
      expect(row.requires_approval).toBe(0);
    });
  });

  it("identity category lands at status=active when classifier not wired (Section 4d.3 — legacy gate retired)", async () => {
    await withStore(async (store) => {
      store.convState.upsert("claude:coding", {
        harness: "claude-code",
        domain: "coding",
      });
      await call(store, "remember", {
        agent_id: "codex",
        title: "user identity",
        body: "Jim is the owner",
        category: "identity",
        conv_id: "claude:coding",
      });
      const row = lastMemory(store);
      expect(row.domain).toBe("coding");
      // Section 4d.3 — agents no longer get protected routing for
      // free via `category=identity`. With the classifier worker
      // unwired, the memory lands at active with conservative-default
      // booleans. The classifier-cutover path (Section 4d.1 — enable
      // the classifier from the /classifier dashboard cockpit) routes
      // via pendingClassification instead.
      expect(row.status).toBe("active");
      expect(row.requires_approval).toBe(0);
    });
  });
});
