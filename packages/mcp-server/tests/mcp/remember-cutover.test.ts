// remember verb — inbox cutover routing (plan 036 Phase 4 / spec 035 §F5).
// When LIBRARIAN_CONSOLIDATOR is on AND the store is on the markdown backend,
// `remember` is a fire-and-forget submission to the consolidator inbox;
// otherwise it writes directly via createMemory (the legacy path, unchanged by
// default). Dispatched through handleMcpPayload over a real store.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LibrarianStore, createLibrarianStore } from "@librarian/core";
import { handleMcpPayload } from "@librarian/mcp-server";
import { afterEach, describe, expect, it } from "vitest";

let store: LibrarianStore | null = null;
let dataDir = "";
let savedFlag: string | undefined;

function makeStore(): void {
  savedFlag = process.env.LIBRARIAN_CONSOLIDATOR;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-remember-"));
  store = createLibrarianStore({ dataDir });
}

afterEach(() => {
  try {
    store?.close();
  } catch {
    /* ignore */
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  store = null;
  if (savedFlag === undefined) delete process.env.LIBRARIAN_CONSOLIDATOR;
  else process.env.LIBRARIAN_CONSOLIDATOR = savedFlag;
});

type CallResult = { result: { content: { text: string }[] } };
const remember = (args: Record<string, unknown>): Promise<unknown> =>
  handleMcpPayload(store as never, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "remember", arguments: args },
  });
const text = (res: unknown): string => (res as CallResult).result.content[0]!.text;

describe("remember verb — inbox cutover routing", () => {
  it("submits to the inbox (not a memory) when the consolidator is on + markdown", async () => {
    makeStore();
    process.env.LIBRARIAN_CONSOLIDATOR = "on";

    const res = await remember({ title: "Anna", body: "moved to Berlin", agent_id: "agent-a" });

    expect(text(res)).toMatch(/queued for consolidation/i);
    // Nothing filed as a memory yet — it's in the inbox awaiting consolidation.
    expect(store!.listMemories({}).total).toBe(0);
    const inboxFiles = fs
      .readdirSync(path.join(dataDir, "vault", "inbox"))
      .filter((f) => f.endsWith(".md"));
    expect(inboxFiles).toHaveLength(1);
  });

  it("writes directly (createMemory) when the consolidator is off — the default", async () => {
    makeStore();
    delete process.env.LIBRARIAN_CONSOLIDATOR;

    const res = await remember({ title: "T", body: "B", agent_id: "agent-a" });

    expect(text(res)).toMatch(/Memory saved/);
    expect(store!.listMemories({ status: "active" }).total).toBe(1);
  });

  it("falls through to a direct write for an empty submission (no empty inbox item to loop on)", async () => {
    makeStore();
    process.env.LIBRARIAN_CONSOLIDATOR = "on";

    // No title and no body → nothing to consolidate.
    const res = await remember({ agent_id: "agent-a" });

    expect(text(res)).toMatch(/Memory saved/);
    expect(store!.listMemories({ status: "active" }).total).toBe(1);
    const inboxDir = path.join(dataDir, "vault", "inbox");
    const inboxFiles = fs.existsSync(inboxDir)
      ? fs.readdirSync(inboxDir).filter((f) => f.endsWith(".md"))
      : [];
    expect(inboxFiles).toHaveLength(0);
  });
});
