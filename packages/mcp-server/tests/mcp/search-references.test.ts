// search_references MCP tool (plan 036 Phase 3 / spec 035 §F3-F4). Tier-0
// lookup over the vault's references/ via handleMcpPayload. Backend-independent
// (references live in the vault), so the default test store (sqlite) serves
// references dropped under <dataDir>/vault/references/.

import fs from "node:fs";
import path from "node:path";
import { handleMcpPayload } from "@librarian/mcp-server";
import { describe, expect, it } from "vitest";
import { withStore } from "../../../../test/helpers.js";

type CallResult = { result: { content: { text: string }[] } };

function writeReference(dataDir: string, name: string, body: string): void {
  const dir = path.join(dataDir, "vault", "references");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);
}

const call = (store: unknown, args: Record<string, unknown>): Promise<unknown> =>
  handleMcpPayload(store as never, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "search_references", arguments: args },
  });

describe("search_references MCP tool", () => {
  it("is advertised to agents", async () => {
    await withStore(async (store: unknown) => {
      const list = (await handleMcpPayload(store as never, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      })) as { result: { tools: { name: string }[] } };
      expect(list.result.tools.map((t) => t.name)).toContain("search_references");
    });
  });

  it("returns the matching reference's path + relevant section", async () => {
    await withStore(async (store: unknown, dataDir: string) => {
      writeReference(
        dataDir,
        "piano-manual.md",
        "## Tuning\nthe grand piano needs tuning twice a year\n\n## Cleaning\nwipe the keys",
      );
      writeReference(dataDir, "sailing.md", "navigating boats across open water");
      const res = (await call(store, { query: "piano tuning" })) as CallResult;
      const refs = JSON.parse(res.result.content[0]!.text).references;
      expect(refs[0].id).toBe("references/piano-manual.md");
      expect(refs[0].section).toContain("## Tuning");
      expect(refs[0].section).not.toContain("## Cleaning");
    });
  });

  it("rejects an empty query (fail-soft)", async () => {
    await withStore(async (store: unknown) => {
      const res = (await call(store, { query: "  " })) as CallResult;
      expect(res.result.content[0]!.text).toContain("rejected");
    });
  });

  it("returns an empty list when there are no references", async () => {
    await withStore(async (store: unknown) => {
      const res = (await call(store, { query: "anything" })) as CallResult;
      expect(JSON.parse(res.result.content[0]!.text).references).toEqual([]);
    });
  });
});
