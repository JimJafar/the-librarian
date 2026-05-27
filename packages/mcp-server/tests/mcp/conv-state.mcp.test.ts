// T2.2 — MCP tool surface for the conversation-state registry.
//
// Pins the dispatch wiring, input-schema shape, and round-trip
// behaviour for `conv_state_get`, `conv_state_upsert`, and
// `conv_state_clear`. These tools are agent-callable (no admin gate —
// the conversation owns its own state per spec §4.8).

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

function extractText(response: AnyResponse): string {
  return response.result.content[0].text as string;
}

describe("MCP conv_state tools (T2.2)", () => {
  it("tools/list exposes get/upsert/clear", async () => {
    await withStore(async (store) => {
      const list = await handleMcpPayload(store, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      const names = list.result.tools.map((tool: { name: string }) => tool.name);
      expect(names).toContain("conv_state_get");
      expect(names).toContain("conv_state_upsert");
      expect(names).toContain("conv_state_clear");
    });
  });

  it("get reports 'no conversation state' for an unknown conv_id", async () => {
    await withStore(async (store) => {
      const response = await call(store, "conv_state_get", { conv_id: "claude:nope" });
      expect(extractText(response)).toMatch(/No conversation state/);
    });
  });

  it("upsert then get round-trips a new row", async () => {
    await withStore(async (store) => {
      const upsert = await call(store, "conv_state_upsert", {
        conv_id: "claude:abc",
        harness: "claude-code",
        domain: "coding",
      });
      const upsertJson = JSON.parse(extractText(upsert));
      expect(upsertJson.conv_id).toBe("claude:abc");
      expect(upsertJson.domain).toBe("coding");

      const get = await call(store, "conv_state_get", { conv_id: "claude:abc" });
      const getJson = JSON.parse(extractText(get));
      expect(getJson).toEqual(upsertJson);
    });
  });

  it("upsert on first-create without harness/domain returns an error message", async () => {
    await withStore(async (store) => {
      const response = await call(store, "conv_state_upsert", {
        conv_id: "claude:incomplete",
        off_record: true,
      });
      expect(extractText(response)).toMatch(/first-create requires both `harness` and `domain`/);
    });
  });

  it("upsert with session_id: null clears the attached session", async () => {
    await withStore(async (store) => {
      await call(store, "conv_state_upsert", {
        conv_id: "claude:abc",
        harness: "claude-code",
        domain: "coding",
        session_id: "ses_initial",
      });
      const cleared = await call(store, "conv_state_upsert", {
        conv_id: "claude:abc",
        session_id: null,
      });
      const json = JSON.parse(extractText(cleared));
      expect(json.session_id).toBeNull();
    });
  });

  it("clear removes the row; subsequent get reports 'no state'", async () => {
    await withStore(async (store) => {
      await call(store, "conv_state_upsert", {
        conv_id: "claude:abc",
        harness: "claude-code",
        domain: "coding",
      });
      await call(store, "conv_state_clear", { conv_id: "claude:abc" });
      const get = await call(store, "conv_state_get", { conv_id: "claude:abc" });
      expect(extractText(get)).toMatch(/No conversation state/);
    });
  });

  it("clear is idempotent — returns success even when the row is absent", async () => {
    await withStore(async (store) => {
      const response = await call(store, "conv_state_clear", { conv_id: "never-seen" });
      expect(extractText(response)).toMatch(/Cleared conversation state/);
    });
  });
});
