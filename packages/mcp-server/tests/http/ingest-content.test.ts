// /ingest `content` branch, end-to-end (ingest spec Task 4; criteria 4, 11, 15).
//
// The endpoint returns 202 synchronously and processes the capture in the
// BACKGROUND (D22). This proves the seam: POST a `content` body with a capture
// token → 202 {queued,id} → a reference file lands under references/web/ →
// search_references (agent token, /mcp) returns it. The on-disk poll is the
// deterministic signal; the background timing is bounded by a short wait so the
// test is solid rather than racy.

import fs from "node:fs";
import path from "node:path";
import { createAgentToken, createLibrarianStore } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function webRefs(dataDir: string): string[] {
  const dir = path.join(dataDir, "vault", "references", "web");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
}

/** Poll the vault until a web reference appears, bounded so a hang fails fast. */
async function waitForWebRef(dataDir: string, timeoutMs = 4000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const refs = webRefs(dataDir);
    if (refs.length > 0) return refs;
    if (Date.now() >= deadline) return refs;
    await sleep(50);
  }
}

describe("/ingest content branch — background write to a vault reference", () => {
  it("202s, then writes references/web/<date>-<slug>.md and makes it searchable", async () => {
    const dataDir = makeTempDir();
    const seed = createLibrarianStore({ dataDir });
    const agentTok = createAgentToken(seed, { agentId: "claude", scope: "agent" });
    const captureTok = createAgentToken(seed, { agentId: "clipper", scope: "capture" });
    seed.close();

    const server = await startHttpServer({ dataDir });
    try {
      const res = await fetch(`${server.url}/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${captureTok.token}`,
        },
        body: JSON.stringify({
          content: "## Espresso\nThe lever machine pulls a ristretto shot under nine bars.",
          url: "https://coffee.example.com/lever-machines",
          title: "Lever Espresso Machines",
          via: "extension",
        }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { status: string; id: string };
      expect(body.status).toBe("queued");
      expect(body.id.length).toBeGreaterThan(0);

      const date = new Date().toISOString().slice(0, 10);
      const refs = await waitForWebRef(dataDir);
      expect(refs).toContain(`${date}-lever-espresso-machines.md`);

      // Searchable via the agent surface (lazy index, no build step).
      const search = await fetch(`${server.url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${agentTok.token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "search_references", arguments: { query: "espresso lever machine" } },
        }),
      });
      expect(search.status).toBe(200);
      const payload = (await search.json()) as { result: { content: { text: string }[] } };
      const references = JSON.parse(payload.result.content[0]!.text).references as {
        id: string;
      }[];
      expect(references.map((r) => r.id)).toContain(
        `references/web/${date}-lever-espresso-machines.md`,
      );
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
