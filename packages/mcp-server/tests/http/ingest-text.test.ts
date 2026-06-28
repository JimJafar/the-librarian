// /ingest `text` branch, end-to-end (ingest spec Task 5; criteria 4, 14-text).
//
// The endpoint returns 202 synchronously and processes the capture in the
// BACKGROUND (D22). This proves the seam: POST a `{text, via}` body with a
// capture token → 202 {queued,id} → a note reference lands under references/web/
// (titled from the first line) → search_references (agent token, /mcp) returns
// it. The on-disk poll is the deterministic signal; background timing is bounded
// by a short wait so the test is solid rather than racy.

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

describe("/ingest text branch — background write to a note reference", () => {
  it("202s, then writes a first-line-titled note and makes it searchable", async () => {
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
          text: "Sourdough hydration notes\nA wetter dough at 80% hydration opens the crumb.",
          via: "ios",
        }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { status: string; id: string };
      expect(body.status).toBe("queued");
      expect(body.id.length).toBeGreaterThan(0);

      const date = new Date().toISOString().slice(0, 10);
      const refs = await waitForWebRef(dataDir);
      expect(refs).toContain(`${date}-sourdough-hydration-notes.md`);

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
          params: {
            name: "search_references",
            arguments: { query: "sourdough dough hydration crumb" },
          },
        }),
      });
      expect(search.status).toBe(200);
      const payload = (await search.json()) as { result: { content: { text: string }[] } };
      const references = JSON.parse(payload.result.content[0]!.text).references as {
        id: string;
      }[];
      expect(references.map((r) => r.id)).toContain(
        `references/web/${date}-sourdough-hydration-notes.md`,
      );
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
