// propose_memory verb — inbox cutover routing (ADR 0004). When intake is enabled
// (`curator.intake.enabled`) propose_memory submits to the intake inbox with
// a force-proposal directive (so it is deduped/merged but always terminates as a
// proposal), rather than writing a standalone proposal directly. When intake is off
// it keeps the legacy direct write — but now surfaces detected duplicates, parity
// with `remember`. Dispatched through handleMcpPayload over a real store.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { INTAKE_ENABLED_KEY, type LibrarianStore, createLibrarianStore } from "@librarian/core";
import { handleMcpPayload } from "@librarian/mcp-server";
import { afterEach, describe, expect, it } from "vitest";

let store: LibrarianStore | null = null;
let dataDir = "";

function makeStore(): void {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-propose-"));
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
});

type CallResult = { result: { content: { text: string }[] } };
const propose = (args: Record<string, unknown>): Promise<unknown> =>
  handleMcpPayload(store as never, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "propose_memory", arguments: args },
  });
const text = (res: unknown): string => (res as CallResult).result.content[0]!.text;

describe("propose_memory verb — inbox cutover routing (ADR 0004)", () => {
  it("submits to the inbox with a force-proposal directive when intake is enabled", async () => {
    makeStore();
    store!.setSetting(INTAKE_ENABLED_KEY, "true");

    const res = await propose({ title: "Anna", body: "moved to Berlin", agent_id: "agent-a" });

    expect(text(res)).toMatch(/queued for review/i);
    // Nothing filed yet — it's in the inbox awaiting intake, NOT a direct proposal.
    expect(store!.listMemories({}).total).toBe(0);
    const inboxDir = path.join(dataDir, "vault", "inbox");
    const inboxFiles = fs.readdirSync(inboxDir).filter((f) => f.endsWith(".md"));
    expect(inboxFiles).toHaveLength(1);
    // The submission carries the force-proposal directive so intake lands a
    // proposal, never an auto-apply.
    const raw = fs.readFileSync(path.join(inboxDir, inboxFiles[0]!), "utf8");
    expect(raw).toMatch(/force_proposal:\s*true/);
  });

  it("writes directly at proposed and surfaces duplicates when intake is off", async () => {
    makeStore();
    // Seed an active memory the proposal restates (same agent + identical content).
    store!.createMemory({ agent_id: "agent-a", title: "Anna", body: "Anna lives in Berlin." });

    const res = await propose({
      title: "Anna",
      body: "Anna lives in Berlin.",
      agent_id: "agent-a",
    });

    // Legacy path: a proposal is created synchronously...
    expect(store!.listMemories({ status: "proposed" }).total).toBe(1);
    // ...and the detected duplicate is surfaced (no longer silently dropped).
    expect(text(res)).toMatch(/duplicat/i);
  });
});
