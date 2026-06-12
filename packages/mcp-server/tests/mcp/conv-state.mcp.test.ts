// T2.2 — MCP tool surface for the conversation-state registry.
//
// Pins the dispatch wiring, input-schema shape, and round-trip
// behaviour for `conv_state_get`, `conv_state_upsert`, and
// `conv_state_clear`. These tools are agent-callable (no admin gate —
// the conversation owns its own state per spec §4.8).

import { AWARENESS_PRIMER_KEY, DEFAULT_AWARENESS_PRIMER } from "@librarian/core";
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

  it("get returns a JSON object with the primer (no row) for an unknown conv_id", async () => {
    await withStore(async (store) => {
      const response = await call(store, "conv_state_get", { conv_id: "claude:nope" });
      const json = JSON.parse(extractText(response));
      // No row → just `{ primer }` (spec 041 Decision 1), replacing the old
      // "No conversation state…" text. Old plugins find no `conv_id` → no block.
      expect(json.conv_id).toBeUndefined();
      expect(json.primer).toBe(DEFAULT_AWARENESS_PRIMER);
    });
  });

  // ADR 0006 — the working-style preamble (formerly carried by the retired
  // `session_manifest` tool) now rides the primer `conv_state_get` injects.
  it("folds the working_style preamble into the injected primer when it is set", async () => {
    await withStore(async (store) => {
      store.setSetting("working_style", "Be concise. Prefer bullet points.");
      const response = await call(store, "conv_state_get", { conv_id: "claude:ws" });
      const json = JSON.parse(extractText(response));
      expect(json.primer).toContain(DEFAULT_AWARENESS_PRIMER);
      expect(json.primer).toContain("Be concise. Prefer bullet points.");
    });
  });

  it("leaves the injected primer unchanged when working_style is empty", async () => {
    await withStore(async (store) => {
      store.setSetting("working_style", "");
      const response = await call(store, "conv_state_get", { conv_id: "claude:ws-empty" });
      const json = JSON.parse(extractText(response));
      expect(json.primer).toBe(DEFAULT_AWARENESS_PRIMER);
    });
  });

  it("upsert then get round-trips a new row", async () => {
    await withStore(async (store) => {
      const upsert = await call(store, "conv_state_upsert", {
        conv_id: "claude:abc",
        harness: "claude-code",
      });
      const upsertJson = JSON.parse(extractText(upsert));
      expect(upsertJson.conv_id).toBe("claude:abc");
      expect(upsertJson.harness).toBe("claude-code");

      const get = await call(store, "conv_state_get", { conv_id: "claude:abc" });
      const getJson = JSON.parse(extractText(get));
      // The row fields stay top-level (back-compat); `primer` is additive.
      const { primer, ...row } = getJson;
      expect(row).toEqual(upsertJson);
      expect(primer).toBe(DEFAULT_AWARENESS_PRIMER);
    });
  });

  it("upsert on first-create without harness returns a JSON-RPC error", async () => {
    await withStore(async (store) => {
      const response = await call(store, "conv_state_upsert", {
        conv_id: "claude:incomplete",
        off_record: true,
      });
      expect(response.error).toBeTruthy();
      expect(response.error.message).toMatch(/first-create requires `harness`/);
    });
  });

  it("empty conv_id is rejected as a JSON-RPC error, not as text content", async () => {
    await withStore(async (store) => {
      const response = await call(store, "conv_state_get", { conv_id: "" });
      expect(response.error).toBeTruthy();
      expect(response.error.message).toMatch(/conv_id is required/);
    });
  });

  it("upsert with session_id: null clears the attached session", async () => {
    await withStore(async (store) => {
      await call(store, "conv_state_upsert", {
        conv_id: "claude:abc",
        harness: "claude-code",
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
      });
      await call(store, "conv_state_clear", { conv_id: "claude:abc" });
      const get = await call(store, "conv_state_get", { conv_id: "claude:abc" });
      const json = JSON.parse(extractText(get));
      expect(json.conv_id).toBeUndefined();
      expect(json.primer).toBe(DEFAULT_AWARENESS_PRIMER);
    });
  });

  it("clear is idempotent — returns success even when the row is absent", async () => {
    await withStore(async (store) => {
      const response = await call(store, "conv_state_clear", { conv_id: "never-seen" });
      expect(extractText(response)).toMatch(/Cleared conversation state/);
    });
  });
});

// Spec 041 (1B awareness primer), Task A2 — `conv_state_get` returns an additive
// top-level `primer` field on EVERY call (Decision 1, backward-compatible). The
// row fields stay top-level so un-updated plugins keep working; the no-row case
// returns `{ primer }` (replacing the old "No conversation state…" text).
describe("conv_state_get returns the additive primer field (spec 041 A2)", () => {
  it("WITH A ROW: row fields stay top-level + adds the primer (back-compat)", async () => {
    await withStore(async (store) => {
      await call(store, "conv_state_upsert", {
        conv_id: "claude:withrow",
        harness: "claude-code",
        off_record: true,
      });
      const get = await call(store, "conv_state_get", { conv_id: "claude:withrow" });
      const json = JSON.parse(extractText(get));
      // Existing row fields are still where un-updated plugins expect them.
      expect(json.conv_id).toBe("claude:withrow");
      expect(json.off_record).toBe(true);
      // …plus the additive primer.
      expect(json.primer).toBe(DEFAULT_AWARENESS_PRIMER);
    });
  });

  it("WITH NO ROW: returns just `{ primer }` (no conv_id) — the day-one floor", async () => {
    await withStore(async (store) => {
      const get = await call(store, "conv_state_get", { conv_id: "claude:norow" });
      const json = JSON.parse(extractText(get));
      expect(json.conv_id).toBeUndefined();
      expect(json.off_record).toBeUndefined();
      expect(json.primer).toBe(DEFAULT_AWARENESS_PRIMER);
    });
  });

  it("SETTING EMPTY: a disabled primer yields `primer: ''` (with a row)", async () => {
    await withStore(async (store) => {
      store.setSetting(AWARENESS_PRIMER_KEY, "");
      await call(store, "conv_state_upsert", {
        conv_id: "claude:empty",
        harness: "claude-code",
      });
      const get = await call(store, "conv_state_get", { conv_id: "claude:empty" });
      const json = JSON.parse(extractText(get));
      expect(json.conv_id).toBe("claude:empty");
      expect(json.primer).toBe("");
    });
  });

  it("SETTING EMPTY: a disabled primer yields `primer: ''` (no row)", async () => {
    await withStore(async (store) => {
      store.setSetting(AWARENESS_PRIMER_KEY, "");
      const get = await call(store, "conv_state_get", { conv_id: "claude:empty-norow" });
      const json = JSON.parse(extractText(get));
      expect(json.conv_id).toBeUndefined();
      expect(json.primer).toBe("");
    });
  });

  it("CUSTOM primer round-trips verbatim into the response", async () => {
    await withStore(async (store) => {
      const custom = "You have memory. Use recall first.";
      store.setSetting(AWARENESS_PRIMER_KEY, custom);
      const get = await call(store, "conv_state_get", { conv_id: "claude:custom" });
      const json = JSON.parse(extractText(get));
      expect(json.primer).toBe(custom);
    });
  });

  it("FAIL-SOFT: an unreadable settings store yields `primer: ''` and never throws", async () => {
    await withStore(async (store) => {
      // The primer read fires every turn — a locked/unreadable settings store
      // must degrade to "" (no primer), never block the turn.
      store.getSetting = () => {
        throw new Error("settings store is locked");
      };
      const get = await call(store, "conv_state_get", { conv_id: "claude:locked" });
      const json = JSON.parse(extractText(get));
      expect(json.conv_id).toBeUndefined();
      expect(json.primer).toBe("");
    });
  });
});
