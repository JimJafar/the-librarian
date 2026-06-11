// flag_memory verb (spec 047 / ADR 0006) — and the retirement of verify_memory.
//
// An agent flags a memory as incorrect/misleading/outdated with a free-text
// reason. The flag is route-to-review: it never changes the memory's status
// and never deletes it; the flagger is the calling agent resolved server-side,
// never a client-supplied id. Dispatched through handleMcpPayload over a real
// markdown-backed store (the default backend post-cutover).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LibrarianStore, createLibrarianStore } from "@librarian/core";
import { handleMcpPayload } from "@librarian/mcp-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let store: LibrarianStore | null = null;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-flag-"));
  store = createLibrarianStore({ dataDir });
});

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
type ErrResult = { error: { code: number; message: string } };

const call = (name: string, args: Record<string, unknown>): Promise<unknown> =>
  handleMcpPayload(store as never, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });

const listToolNames = async (): Promise<string[]> => {
  const res = (await handleMcpPayload(store as never, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  })) as { result: { tools: { name: string }[] } };
  return res.result.tools.map((t) => t.name);
};

const text = (res: unknown): string => (res as CallResult).result.content[0]!.text;

describe("flag_memory verb", () => {
  it("records a free-text flag without changing the memory's status", async () => {
    const { memory } = store!.createMemory({ agent_id: "codex", title: "Old fact", body: "stale" });

    const res = await call("flag_memory", {
      agent_id: "codex",
      memory_id: memory.id,
      reason: "this is outdated",
    });

    expect(text(res)).toMatch(/flag/i);
    const after = store!.getMemory(memory.id)!;
    expect(after.status).toBe("active"); // route-to-review, never archive
    expect(after.flags).toHaveLength(1);
    expect(after.flags[0]).toMatchObject({ reason: "this is outdated" });
  });

  it("stamps the flag with the calling agent resolved from the authenticated context", async () => {
    const { memory } = store!.createMemory({ agent_id: "codex", title: "X", body: "y" });

    // The caller is authenticated as "claude"; the flagger is taken from that
    // context, not from anything the client could put in the body.
    await handleMcpPayload(
      store as never,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "flag_memory",
          arguments: { memory_id: memory.id, reason: "stale" },
        },
      },
      { role: "agent", agentId: "claude" },
    );

    const after = store!.getMemory(memory.id)!;
    expect(after.flags).toHaveLength(1);
    expect(after.flags[0]!.agent_id).toBe("claude");
  });

  it("rejects an impersonation attempt where a forged agent_id contradicts the authenticated caller", async () => {
    const { memory } = store!.createMemory({ agent_id: "codex", title: "X", body: "y" });

    const res = (await handleMcpPayload(
      store as never,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "flag_memory",
          arguments: { agent_id: "spoofed-victim", memory_id: memory.id, reason: "nope" },
        },
      },
      { role: "agent", agentId: "claude" },
    )) as { error: { message: string } };

    // The caller-identity resolver refuses to flag under a contradicting id, and
    // no flag is recorded.
    expect(res.error.message).toMatch(/impersonation|does not match/i);
    expect(store!.getMemory(memory.id)!.flags).toEqual([]);
  });

  it("advertises flag_memory in tools/list", async () => {
    expect(await listToolNames()).toContain("flag_memory");
  });
});

describe("verify_memory retirement", () => {
  it("no longer advertises verify_memory under any role", async () => {
    expect(await listToolNames()).not.toContain("verify_memory");
  });

  it("returns a tool-not-found error when verify_memory is called", async () => {
    const res = (await call("verify_memory", {
      memory_id: "mem_x",
      result: "useful",
    })) as ErrResult;
    expect(res.error.message).toMatch(/Unknown tool: verify_memory/);
  });
});
