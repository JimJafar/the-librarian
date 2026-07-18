import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LibrarianStore, createLibrarianStore } from "@librarian/core";
import { type ToolDefinition, type ToolContext, dispatchMcp } from "@librarian/mcp-server";
import { afterEach, describe, expect, it } from "vitest";
import { buildToolRegistry } from "../../dist/plugin.js";

const ADMIN_ONLY_TOOL: ToolDefinition = {
  name: "test_admin_only_refusal",
  description: "Test-only admin tool.",
  inputSchema: { type: "object", properties: {} },
  adminOnly: true,
  handler: () => ({ content: [{ type: "text", text: "reached" }] }),
};

const registry = buildToolRegistry([{ name: "refusal-test", tools: [ADMIN_ONLY_TOOL] }]);
const stores: LibrarianStore[] = [];
const dataDirs: string[] = [];

function makeStore(armed: boolean): LibrarianStore {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-refusal-dispatch-"));
  dataDirs.push(dataDir);
  const store = createLibrarianStore({ dataDir, refusalLog: { armed } });
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dataDir of dataDirs.splice(0)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

describe("MCP dispatch refusal evidence", () => {
  it("records an admin-only denial with tool and principal fields", async () => {
    const store = makeStore(true);
    const principal: ToolContext["principal"] = {
      kind: "agent",
      actorId: "agent:alice",
      boundActorId: "agent:alice",
      roles: ["agent"],
      tokenId: "tok-agent",
    };

    await expect(
      dispatchMcp(
        store,
        "tools/call",
        { name: ADMIN_ONLY_TOOL.name, arguments: {} },
        { principal },
        registry,
      ),
    ).rejects.toThrow(/requires admin authorization/i);

    expect((await store.readRefusals()).rows).toEqual([
      expect.objectContaining({
        kind: "tool-admin-only",
        surface: "public",
        outcome: "refused",
        tool: ADMIN_ONLY_TOOL.name,
        actorId: "agent:alice",
        roles: ["agent"],
        tokenId: "tok-agent",
      }),
    ]);
  });

  it("keeps the same stdio/default unarmed path inert", async () => {
    const store = makeStore(false);

    await expect(
      dispatchMcp(
        store,
        "tools/call",
        { name: ADMIN_ONLY_TOOL.name, arguments: {} },
        { role: "agent" },
        registry,
      ),
    ).rejects.toThrow(/requires admin authorization/i);

    expect(await store.readRefusals()).toEqual({ rows: [], total: 0, dropped: 0 });
    expect(fs.existsSync(path.join(store.dataDir, "refusal-log.ndjson"))).toBe(false);
  });
});
