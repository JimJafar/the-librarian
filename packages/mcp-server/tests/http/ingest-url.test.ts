// /ingest `url` branch wiring, end-to-end (ingest spec Task 6; criteria 4, 16).
//
// The happy-path fetch+extract pipeline is covered at the core level
// (packages/core/tests/process-url.test.ts) where the SSRF guard can be relaxed
// for a loopback fixture server. At the ROUTE level the REAL guard is in force
// (no relaxation seam), so this test proves the wiring the only way it can with
// the production guard: a url capture aimed at a BLOCKED target (the cloud
// metadata endpoint) is accepted (202) but the background processor refuses the
// fetch, logs a `failed` row, and writes NO reference. That exercises the route →
// processUrlCapture → SSRF guard path that the content/text branches don't.

import fs from "node:fs";
import path from "node:path";
import { createAgentToken, createLibrarianStore, listRecent } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function webRefs(dataDir: string): string[] {
  const dir = path.join(dataDir, "vault", "references", "web");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
}

/** Poll the ingest log (read from a fresh store on the same dataDir) until the row leaves `pending`. */
async function waitForResolved(dataDir: string, id: string, timeoutMs = 4000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = createLibrarianStore({ dataDir });
    const row = listRecent(probe, 100).find((r) => r.id === id);
    probe.close();
    if (row && row.status !== "pending") return row.status;
    if (Date.now() >= deadline) return row?.status ?? "missing";
    await sleep(50);
  }
}

describe("/ingest url branch — SSRF-guarded background fetch", () => {
  it("202s, then refuses a blocked (metadata) target: failed row, no reference written", async () => {
    const dataDir = makeTempDir();
    const seed = createLibrarianStore({ dataDir });
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
        body: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data/", via: "ios" }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { status: string; id: string };
      expect(body.status).toBe("queued");
      expect(body.id.length).toBeGreaterThan(0);

      const status = await waitForResolved(dataDir, body.id);
      expect(status).toBe("failed");
      expect(webRefs(dataDir)).toHaveLength(0);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
