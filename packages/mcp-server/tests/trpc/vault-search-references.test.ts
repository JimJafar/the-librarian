// vault.searchReferences tRPC procedure (spec 2026-06-19 — dashboard retrieval
// testers, Task 1). The dashboard's "References" tab runs the same Tier-0
// reference lookup an agent's `search_references` MCP tool runs — so the
// operator sees exactly what the agent sees. Parity is the whole point: this
// procedure is a thin pass-through to `store.searchReferences`, the identical
// store method the MCP tool calls. The tests below run BOTH surfaces against
// one store and assert the references match.

import fs from "node:fs";
import path from "node:path";
import { appRouter, createCallerFactory, handleMcpPayload } from "@librarian/mcp-server";
import { describe, expect, it } from "vitest";
import { withStore } from "../../../../test/helpers.js";

const createCaller = createCallerFactory(appRouter);

function admin(store: unknown) {
  return createCaller({
    role: "admin",
    store: store as never,
    secretKey: null,
    adminToken: "admin-token",
  });
}

function writeReference(dataDir: string, name: string, body: string): void {
  const dir = path.join(dataDir, "vault", "references");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);
}

interface ReferenceHit {
  id: string;
  score: number;
  section: string;
}

/** The agent-facing payload: parse the MCP tool's text result. */
async function mcpSearch(store: unknown, query: string): Promise<ReferenceHit[]> {
  const res = (await handleMcpPayload(store as never, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "search_references", arguments: { query } },
  })) as { result: { content: { text: string }[] } };
  return JSON.parse(res.result.content[0]!.text).references as ReferenceHit[];
}

describe("tRPC vault.searchReferences (spec 2026-06-19 Task 1)", () => {
  it("returns the matching reference's path + relevant section", async () => {
    await withStore(async (store: unknown, dataDir: string) => {
      writeReference(
        dataDir,
        "piano-manual.md",
        "## Tuning\nthe grand piano needs tuning twice a year\n\n## Cleaning\nwipe the keys",
      );
      writeReference(dataDir, "sailing.md", "navigating boats across open water");

      const { references } = await admin(store).vault.searchReferences({ query: "piano tuning" });

      expect(references[0]!.id).toBe("references/piano-manual.md");
      expect(references[0]!.section).toContain("## Tuning");
      expect(references[0]!.section).not.toContain("## Cleaning");
    });
  });

  it("is identical to the search_references MCP tool for the same query+vault", async () => {
    await withStore(async (store: unknown, dataDir: string) => {
      writeReference(
        dataDir,
        "piano-manual.md",
        "## Tuning\nthe grand piano needs tuning twice a year\n\n## Cleaning\nwipe the keys",
      );
      writeReference(dataDir, "sailing.md", "navigating boats across open water");

      const agentSees = await mcpSearch(store, "piano tuning");
      const { references } = await admin(store).vault.searchReferences({ query: "piano tuning" });

      // What the dashboard shows IS what the agent sees — same ids, order, sections.
      expect(references).toEqual(agentSees);
    });
  });

  it("rejects an empty / whitespace query with a teaching BAD_REQUEST", async () => {
    await withStore(async (store: unknown) => {
      await expect(admin(store).vault.searchReferences({ query: "   " })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });
  });

  it("is admin-gated — an anonymous caller is turned away", async () => {
    await withStore(async (store: unknown) => {
      const anon = createCaller({
        role: "anonymous",
        store: store as never,
        secretKey: null,
        adminToken: "admin-token",
      });
      await expect(anon.vault.searchReferences({ query: "piano" })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    });
  });
});
