// Ingest-log admin tRPC surface (reference-ingest spec criterion 15 / D7).
//
// Spawns the real HTTP bin and exercises `ingest.recent` / `ingest.failures`,
// plus admin gating (the agent role must not reach it). Rows are seeded by
// opening a second store on the SAME data dir and writing through core's
// ingest-log helpers — the settings sidecar reads the JSON file fresh on every
// op, so the running server sees the seeded rows on its next query.

import { createLibrarianStore, markFailed, markSuccess, recordPending } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

interface TrpcOk<T> {
  result: { data: T };
}
interface TrpcErr {
  error: unknown;
}
interface ServerHandle {
  url: string;
  trpcUrl: string;
  token: string;
  stop: () => Promise<void>;
}

interface IngestRow {
  id: string;
  source: string;
  via: string;
  status: "pending" | "success" | "failed";
  error?: string;
  result_path?: string;
  created_at: string;
}

async function trpcGet<T>(server: ServerHandle, path: string, input?: unknown): Promise<T> {
  const url = new URL(`${server.trpcUrl}/trpc/${path}`);
  if (input !== undefined) url.searchParams.set("input", JSON.stringify(input));
  const response = await fetch(url, { headers: { authorization: `Bearer ${server.token}` } });
  const json = (await response.json()) as TrpcOk<T> | TrpcErr;
  if (response.status >= 400 || "error" in json) {
    throw new Error(`trpc GET ${path} failed: ${JSON.stringify(json)}`);
  }
  return (json as TrpcOk<T>).result.data;
}

describe("tRPC ingest surface", () => {
  it("is unreachable from the public (network) listener (ADR 0008 P3)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const res = await fetch(`${server.url}/trpc/ingest.recent`, {
        headers: { authorization: "Bearer agent-token" },
      });
      expect(res.status).toBe(404);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("lists recent attempts newest-first, and the failures list isolates failed rows", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      // Seed three attempts through a sibling store on the same data dir.
      const store = createLibrarianStore({ dataDir });
      let okId: string;
      let failId: string;
      try {
        recordPending(store, { source: "https://example.com/pending", via: "extension" });
        okId = recordPending(store, { source: "https://example.com/saved", via: "ios" });
        markSuccess(store, okId, "references/example-saved.md");
        failId = recordPending(store, { source: "https://example.com/broken", via: "android" });
        markFailed(store, failId, "fetch failed: 503 Service Unavailable");
      } finally {
        store.close();
      }

      const recent = await trpcGet<IngestRow[]>(server, "ingest.recent");
      // All three present, newest-first (the broken one was recorded last).
      expect(recent.length).toBe(3);
      expect(recent[0]?.source).toContain("broken");
      const saved = recent.find((r) => r.id === okId);
      expect(saved).toMatchObject({
        status: "success",
        result_path: "references/example-saved.md",
      });

      const limited = await trpcGet<IngestRow[]>(server, "ingest.recent", { limit: 1 });
      expect(limited.length).toBe(1);

      const failures = await trpcGet<IngestRow[]>(server, "ingest.failures");
      expect(failures.length).toBe(1);
      expect(failures[0]).toMatchObject({ id: failId, status: "failed" });
      expect(failures[0]?.error).toContain("503");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
