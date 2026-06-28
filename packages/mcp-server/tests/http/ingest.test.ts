// Ingest spec Task 3 — /ingest as a validated, async front door.
//
// The endpoint synchronously authenticates (capture scope), enforces a body-size
// cap (413), validates field-presence (400) and `via`, writes a `pending`
// ingest-log row, and returns 202 `{status:"queued", id}` (D22). The actual
// fetch/extract/write pipeline is a later task — here the row stays `pending`.
// Boots the BUILT server like the sibling e2e suites.

import { createAgentToken, createLibrarianStore, listRecent } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

async function withCaptureServer(
  run: (ctx: {
    url: string;
    captureToken: string;
    dataDir: string;
    post: (body: unknown, headers?: Record<string, string>) => Promise<Response>;
  }) => Promise<void>,
): Promise<void> {
  const dataDir = makeTempDir();
  const seed = createLibrarianStore({ dataDir });
  const capture = createAgentToken(seed, { agentId: "clipper", scope: "capture" });
  seed.close();

  const server = await startHttpServer({ dataDir });
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${server.url}/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${capture.token}`,
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  try {
    await run({ url: server.url, captureToken: capture.token, dataDir, post });
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
}

describe("/ingest — field-presence validation (criterion 2, D12)", () => {
  it("400s a body with none of content/url/text, naming the accepted fields", async () => {
    await withCaptureServer(async ({ post }) => {
      const res = await post({ via: "extension" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/content/);
      expect(body.error).toMatch(/url/);
      expect(body.error).toMatch(/text/);
    });
  });

  it("400s an unknown `via`, naming the accepted values", async () => {
    await withCaptureServer(async ({ post }) => {
      const res = await post({ url: "https://example.com/a", via: "carrier-pigeon" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/extension/);
      expect(body.error).toMatch(/ios/);
      expect(body.error).toMatch(/android/);
    });
  });
});

describe("/ingest — request-body size cap (criterion 3, D14)", () => {
  it("413s a body over the ingest cap with a teaching message", async () => {
    await withCaptureServer(async ({ post }) => {
      // ~2.1 MB of JSON, over the ~2 MB cap.
      const big = JSON.stringify({ text: "x".repeat(2_200_000), via: "extension" });
      const res = await post(big);
      expect(res.status).toBe(413);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/too large|cap|MB/i);
    });
  });
});

describe("/ingest — async 202 + pending row (criteria 4, 5, D22)", () => {
  it("queues a valid url capture: 202 {status:queued, id} + a pending log row", async () => {
    await withCaptureServer(async ({ post, dataDir }) => {
      const res = await post({ url: "https://example.com/article", via: "ios" });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { status: string; id: string };
      expect(body.status).toBe("queued");
      expect(typeof body.id).toBe("string");
      expect(body.id.length).toBeGreaterThan(0);

      // A `pending` row was written before the 202 (the dedup/crash-safety invariant).
      const store = createLibrarianStore({ dataDir });
      const recent = listRecent(store, 10);
      store.close();
      const row = recent.find((r) => r.id === body.id);
      expect(row).toBeDefined();
      expect(row?.status).toBe("pending");
      expect(row?.via).toBe("ios");
      expect(row?.source).toContain("example.com");
    });
  });

  it("queues a content capture (no url) with a source marker", async () => {
    await withCaptureServer(async ({ post }) => {
      const res = await post({ content: "# Hello\n\nbody", via: "extension" });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { status: string; id: string };
      expect(body.status).toBe("queued");
      expect(body.id.length).toBeGreaterThan(0);
    });
  });
});

describe("/ingest — per-token rate limit (criterion 10, D19)", () => {
  it("429s once the burst cap is exceeded, with a retry hint in the body", async () => {
    await withCaptureServer(async ({ post }) => {
      // The default burst is 5 per 10 s; a rapid 6th capture trips it. All six
      // requests fall well inside the burst window.
      const statuses: number[] = [];
      let throttled: Response | undefined;
      for (let i = 0; i < 7; i += 1) {
        const res = await post({ url: `https://example.com/a${i}`, via: "extension" });
        statuses.push(res.status);
        if (res.status === 429 && !throttled) throttled = res;
        else await res.body?.cancel();
      }
      // At least the first five succeeded; at least one later one was throttled.
      expect(statuses.filter((s) => s === 202).length).toBeGreaterThanOrEqual(5);
      expect(statuses).toContain(429);
      expect(throttled).toBeDefined();
      const body = (await throttled!.json()) as { error: string; retry_after_seconds: number };
      expect(body.error).toMatch(/rate limit|too many|slow down/i);
      expect(body.retry_after_seconds).toBeGreaterThan(0);
    });
  });
});
