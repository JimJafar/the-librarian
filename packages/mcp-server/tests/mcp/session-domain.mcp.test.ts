// T3.3 — `start_session` inherits the calling conv_state's domain, and
// `continue_session` seeds the resuming conv_state with the session's
// stored domain. Spec §4.12.

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
    { role: context.role || "agent", agentId: context.agentId || "codex" },
  ) as Promise<AnyResponse>;
}

function readSessionDomain(store: LibrarianStore, sessionId: string): string {
  return (
    store.db.prepare("SELECT domain FROM sessions WHERE id = ?").get(sessionId) as {
      domain: string;
    }
  ).domain;
}

describe("MCP start_session + continue_session + domain (T3.3)", () => {
  it("start_session inherits the calling conv_state's domain", async () => {
    await withStore(async (store) => {
      store.db
        .prepare("INSERT INTO domains (name, created_at) VALUES (?, ?)")
        .run("coding", new Date().toISOString());
      store.convState.upsert("claude:coding", {
        harness: "claude-code",
        domain: "coding",
      });
      const response = await call(store, "start_session", {
        title: "implement T3.3",
        harness: "claude-code",
        conv_id: "claude:coding",
      });
      const text = response.result.content[0].text as string;
      const match = text.match(/(ses_[a-f0-9-]+)/);
      expect(match).toBeTruthy();
      const sessionId = match![1];
      expect(readSessionDomain(store, sessionId)).toBe("coding");
    });
  });

  it("start_session without a conv_state defaults to the single-domain fast path", async () => {
    await withStore(async (store) => {
      const response = await call(store, "start_session", {
        title: "single-domain install",
        harness: "claude-code",
      });
      const text = response.result.content[0].text as string;
      const sessionId = text.match(/(ses_[a-f0-9-]+)/)![1];
      expect(readSessionDomain(store, sessionId)).toBe("general");
    });
  });

  it("continue_session with conv_id seeds the new conv_state from session.domain", async () => {
    await withStore(async (store) => {
      store.db
        .prepare("INSERT INTO domains (name, created_at) VALUES (?, ?)")
        .run("coding", new Date().toISOString());
      store.convState.upsert("claude:coding", {
        harness: "claude-code",
        domain: "coding",
      });
      const start = await call(store, "start_session", {
        title: "resume target",
        harness: "claude-code",
        conv_id: "claude:coding",
      });
      const sessionId = (start.result.content[0].text as string).match(/(ses_[a-f0-9-]+)/)![1];

      // Resume into a different conv_id (e.g. a fresh Hermes thread).
      await call(store, "continue_session", {
        session_id: sessionId,
        target_harness: "hermes",
        attach: false,
        conv_id: "hermes:resumed",
      });

      const resumed = store.convState.get("hermes:resumed");
      expect(resumed).toBeTruthy();
      expect(resumed?.domain).toBe("coding");
      expect(resumed?.session_id).toBe(sessionId);
    });
  });

  it("continue_session without conv_id leaves the conv_state registry untouched", async () => {
    await withStore(async (store) => {
      const start = await call(store, "start_session", {
        title: "no resume seed",
        harness: "claude-code",
      });
      const sessionId = (start.result.content[0].text as string).match(/(ses_[a-f0-9-]+)/)![1];
      await call(store, "continue_session", {
        session_id: sessionId,
        target_harness: "hermes",
        attach: false,
      });
      // Nothing seeded — registry is empty.
      const rows = store.db.prepare("SELECT COUNT(*) AS n FROM conversation_state").get() as {
        n: number;
      };
      expect(rows.n).toBe(0);
    });
  });
});
