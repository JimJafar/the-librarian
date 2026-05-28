// T3.2 — `recall` applies the domain hard filter, supports the new
// `tags` and `include_other_domains` inputs, and admin bypasses the
// filter entirely. Spec §4.11.

import type { LibrarianStore } from "@librarian/core";
import { handleMcpPayload } from "@librarian/mcp-server";
import { describe, expect, it } from "vitest";
import { withStore } from "../../../../test/helpers.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyResponse = any;

function call(
  store: LibrarianStore,
  args: Record<string, unknown>,
  context: { role?: "admin" | "agent"; agentId?: string } = {},
): Promise<AnyResponse> {
  return handleMcpPayload(
    store,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recall", arguments: args } },
    { role: context.role || "agent", agentId: context.agentId || "codex" },
  ) as Promise<AnyResponse>;
}

function seedDomains(store: LibrarianStore): {
  codingMemoryId: string;
  familyMemoryId: string;
  globalMemoryId: string;
} {
  // Multi-domain install.
  store.db
    .prepare("INSERT INTO domains (name, created_at) VALUES (?, ?), (?, ?)")
    .run("coding", new Date().toISOString(), "family-admin", new Date().toISOString());

  // One memory per domain plus a global memory that bypasses domain
  // filtering (`is_global=1`).
  store.convState.upsert("claude:coding", { harness: "claude-code", domain: "coding" });
  store.convState.upsert("claude:family", { harness: "claude-code", domain: "family-admin" });

  const codingMemoryId = createInDomain(
    store,
    "claude:coding",
    "pnpm not npm",
    "this repo uses pnpm",
    ["pnpm"],
  );
  const familyMemoryId = createInDomain(
    store,
    "claude:family",
    "tuesday family slot",
    "family slot is tuesday evening",
    ["calendar"],
  );

  // Global memory (Section 4d.2 — `is_global` is no longer derived
  // from `category=identity`; the classifier worker sets it via
  // memory.classified events at runtime. Simulate that emission so
  // the recall-only-globals test has a global to return.
  const globalMemoryId = createInDomain(
    store,
    "claude:coding",
    "owner identity",
    "Jim is the owner of the librarian",
    [],
    "identity",
  );
  store.appendEvent(
    "memory.classified",
    {
      memory_id: globalMemoryId,
      agent_id: "codex",
      input: {
        title: "owner identity",
        body: "Jim is the owner of the librarian",
        tags: [],
      },
      provider: "remote",
      model: "test-model",
      prompt_version: "v1",
      raw_output: '{"requires_approval": true, "is_global": true}',
      parsed: { requires_approval: true, is_global: true },
      queue_wait_ms: 0,
      inference_ms: 1,
      attempt_number: 1,
    },
    { memory_id: globalMemoryId, agent_id: "codex" },
  );

  return { codingMemoryId, familyMemoryId, globalMemoryId };
}

function createInDomain(
  store: LibrarianStore,
  convId: string,
  title: string,
  body: string,
  tags: string[],
  category = "tools",
): string {
  const result = handleMcpPayload(
    store,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "remember",
        arguments: { agent_id: "codex", title, body, category, conv_id: convId, tags },
      },
    },
    { role: "agent", agentId: "codex" },
  );
  void result;
  // The mem id is awkward to extract from the prose; pull it from the
  // store directly by title.
  return (store.db.prepare("SELECT id FROM memories WHERE title = ?").get(title) as { id: string })
    .id;
}

describe("MCP recall + domain hard filter (T3.2)", () => {
  it("returns coding-domain memories and globals when called from a coding conv_state", async () => {
    await withStore(async (store) => {
      const { codingMemoryId, familyMemoryId, globalMemoryId } = seedDomains(store);
      const response = await call(store, {
        agent_id: "codex",
        query: "pnpm tuesday Jim",
        conv_id: "claude:coding",
        include_ids: true,
        limit: 10,
      });
      const text = response.result.content[0].text;
      expect(text).toContain(codingMemoryId);
      // Global proposals are status=proposed (identity routes through
      // requires_approval); recall only returns active rows. Approve the
      // global, then re-query.
      store.approveProposal(globalMemoryId, "approve", {}, "dashboard");
      const reopened = await call(store, {
        agent_id: "codex",
        query: "pnpm tuesday Jim",
        conv_id: "claude:coding",
        include_ids: true,
        limit: 10,
      });
      const text2 = reopened.result.content[0].text;
      expect(text2).toContain(codingMemoryId);
      expect(text2).toContain(globalMemoryId);
      expect(text2).not.toContain(familyMemoryId);
    });
  });

  it("include_other_domains: true drops the domain filter", async () => {
    await withStore(async (store) => {
      const { codingMemoryId, familyMemoryId } = seedDomains(store);
      const response = await call(store, {
        agent_id: "codex",
        query: "pnpm tuesday",
        conv_id: "claude:coding",
        include_other_domains: true,
        include_ids: true,
        limit: 10,
      });
      const text = response.result.content[0].text;
      expect(text).toContain(codingMemoryId);
      expect(text).toContain(familyMemoryId);
    });
  });

  it("tags filter narrows results to matching memories", async () => {
    await withStore(async (store) => {
      const { codingMemoryId, familyMemoryId } = seedDomains(store);
      const response = await call(store, {
        agent_id: "codex",
        query: "pnpm tuesday",
        conv_id: "claude:coding",
        include_other_domains: true,
        tags: ["calendar"],
        include_ids: true,
        limit: 10,
      });
      const text = response.result.content[0].text;
      expect(text).toContain(familyMemoryId);
      expect(text).not.toContain(codingMemoryId);
    });
  });

  it("admin role sees memories across all domains without supplying conv_id", async () => {
    await withStore(async (store) => {
      const { codingMemoryId, familyMemoryId } = seedDomains(store);
      const response = await call(
        store,
        {
          query: "pnpm tuesday",
          include_ids: true,
          limit: 10,
        },
        { role: "admin" },
      );
      const text = response.result.content[0].text;
      expect(text).toContain(codingMemoryId);
      expect(text).toContain(familyMemoryId);
    });
  });

  it("no conv_state on a multi-domain install returns only globals (defensive default)", async () => {
    await withStore(async (store) => {
      const { codingMemoryId, familyMemoryId, globalMemoryId } = seedDomains(store);
      store.approveProposal(globalMemoryId, "approve", {}, "dashboard");
      const response = await call(store, {
        agent_id: "codex",
        query: "pnpm tuesday Jim",
        include_ids: true,
        limit: 10,
      });
      const text = response.result.content[0].text;
      expect(text).toContain(globalMemoryId);
      expect(text).not.toContain(codingMemoryId);
      expect(text).not.toContain(familyMemoryId);
    });
  });
});
