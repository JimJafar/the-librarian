// MCP tool surface for the handoffs subsystem (sessions-rethink §6.1 + §7).
//
// Pins dispatch wiring, the validation boundary, the unclaimed-list default,
// and the 404 / 409 split on claim. The store-level test is in
// packages/core/tests/store/handoff-store.test.ts; this layer asserts that
// MCP-side concerns (Zod validation, error envelopes) behave per spec.

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
  context: { role: "admin" | "agent"; agentId?: string } = { role: "agent", agentId: "agent-a" },
): Promise<AnyResponse> {
  return handleMcpPayload(
    store,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    context,
  ) as Promise<AnyResponse>;
}

function extractText(response: AnyResponse): string {
  return response.result.content[0].text as string;
}

const validDoc = `# Handoff: test

## Start & intent
do the thing.

## Journey
tried X then Y.

## Current state
green tests.

## What's left
ship it.

## Open questions
none.
`;

function defaultInput() {
  return {
    title: "a valid title",
    document_md: validDoc,
    project_key: "proj-x",
    cwd: "/repo",
    harness: "claude-code",
    tags: ["migration"],
    conv_id: "claude:abc",
  };
}

async function seedConvState(store: LibrarianStore, domain = "general") {
  await call(store, "conv_state_upsert", { conv_id: "claude:abc", harness: "claude-code", domain });
}

describe("MCP handoff tools", () => {
  it("tools/list exposes store_handoff / list_handoffs / claim_handoff", async () => {
    await withStore(async (store) => {
      const list = await handleMcpPayload(store, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      const names = list.result.tools.map((tool: { name: string }) => tool.name);
      expect(names).toContain("store_handoff");
      expect(names).toContain("list_handoffs");
      expect(names).toContain("claim_handoff");
    });
  });

  it("store_handoff rejects a missing-heading document at the Zod boundary", async () => {
    await withStore(async (store) => {
      await seedConvState(store);
      const broken = validDoc.replace("## Journey", "## Renamed");
      const response = await call(store, "store_handoff", {
        ...defaultInput(),
        document_md: broken,
      });
      expect(extractText(response)).toMatch(/document_md must include/);
    });
  });

  it("round-trips store → list → claim → list (no surface) → claim 409", async () => {
    await withStore(async (store) => {
      await seedConvState(store);

      // store_handoff returns human-readable text with the handoff_id inline;
      // a regex pulls it out so the test isn't tied to the exact wording.
      const storedText = extractText(await call(store, "store_handoff", defaultInput()));
      const handoffId = /handoff_id:\s*(hdo_[^\s]+)/.exec(storedText)?.[1];
      expect(handoffId).toBeTruthy();

      const listed = JSON.parse(
        extractText(await call(store, "list_handoffs", { project_key: "proj-x", cwd: "/repo" })),
      );
      expect(listed.handoffs.length).toBeGreaterThanOrEqual(1);

      const claimed = JSON.parse(
        extractText(await call(store, "claim_handoff", { handoff_id: handoffId })),
      );
      expect(claimed.handoff_id).toBe(handoffId);
      expect(claimed.document_md).toContain("ship it");

      const afterList = JSON.parse(
        extractText(await call(store, "list_handoffs", { project_key: "proj-x", cwd: "/repo" })),
      );
      expect(
        afterList.handoffs.find((h: { handoff_id: string }) => h.handoff_id === handoffId),
      ).toBeUndefined();

      const conflict = JSON.parse(
        extractText(await call(store, "claim_handoff", { handoff_id: handoffId })),
      );
      expect(conflict.error).toBe("already_claimed");
      expect(conflict.handoff_id).toBe(handoffId);
      expect(conflict.claimed_at).toBeTruthy();
    });
  });

  it("claim of an unknown id returns a 'not_found' envelope", async () => {
    await withStore(async (store) => {
      await seedConvState(store);
      const result = JSON.parse(
        extractText(await call(store, "claim_handoff", { handoff_id: "hdo_ghost" })),
      );
      expect(result.error).toBe("not_found");
    });
  });
});
