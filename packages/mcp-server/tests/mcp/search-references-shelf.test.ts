// Shelf-aware search_references in the MCP tool (spec 062 T6 — SC 8c). The tool consults the
// principal's `search` shelves via store.searchReferencesForPrincipal and merges with provenance:
//   - a MULTI-shelf search tags each hit with its shelf (shelfId, + shelfLabel when the shelf is
//     labelled) in the returned JSON;
//   - a SINGLE-shelf (default-router) search returns plain hits with NO shelf fields — the JSON is
//     byte-identical to today (asserted explicitly, per the inertness rule).

import fs from "node:fs";
import path from "node:path";
import { type Shelf, type VaultRouter, createLibrarianStore } from "@librarian/core";
import { handleMcpPayload } from "@librarian/mcp-server";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../test/helpers.js";

const SARAH: Shelf = {
  id: "members/x",
  prefix: "members/x/",
  writable: true,
  label: "Sarah's shelf",
};
const TEAM: Shelf = { id: "team", prefix: "team/", writable: true };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function storeWith(router?: VaultRouter): ReturnType<typeof createLibrarianStore> {
  const dataDir = makeTempDir();
  dirs.push(dataDir);
  return createLibrarianStore({ dataDir, ...(router ? { vaultRouter: router } : {}) });
}

type Ref = { id: string; shelfId?: string; shelfLabel?: string };

async function searchRefs(
  store: ReturnType<typeof createLibrarianStore>,
  query: string,
): Promise<Ref[]> {
  const res = (await handleMcpPayload(store, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "search_references", arguments: { agent_id: "x", query } },
  })) as { result: { content: { text: string }[] } };
  return JSON.parse(res.result.content[0].text).references as Ref[];
}

describe("MCP search_references shelf provenance (spec 062 SC 8c)", () => {
  it("tags each hit with its shelf under a two-shelf router (labelled + unlabelled)", async () => {
    const router: VaultRouter = { shelves: () => [SARAH, TEAM], writeTarget: () => SARAH };
    const store = storeWith(router);
    store
      .forShelf(SARAH)
      .vaultFiles.createFile(
        "members/x/references/piano-a.md",
        "# Piano A\n\nthe grand piano needs tuning twice a year",
      );
    store
      .forShelf(TEAM)
      .vaultFiles.createFile(
        "team/references/piano-b.md",
        "# Piano B\n\nthe team piano tuning roster",
      );

    const refs = await searchRefs(store, "piano tuning");
    const a = refs.find((r) => r.id === "references/piano-a.md");
    const b = refs.find((r) => r.id === "references/piano-b.md");
    expect(a?.shelfId).toBe("members/x");
    expect(a?.shelfLabel).toBe("Sarah's shelf");
    expect(b?.shelfId).toBe("team");
    expect(b?.shelfLabel).toBeUndefined();
  });

  it("adds NO shelf fields under the default (single-shelf) router — byte-identical JSON", async () => {
    const store = storeWith(); // default router — one shelf, prefix ""
    const dataDir = store.dataDir;
    const dir = path.join(dataDir, "vault", "references");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "piano.md"), "# Piano\n\ntune the piano twice a year");

    const refs = await searchRefs(store, "piano tuning");
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref).not.toHaveProperty("shelfId");
      expect(ref).not.toHaveProperty("shelfLabel");
    }
    expect(refs[0]?.id).toBe("references/piano.md");
  });
});
