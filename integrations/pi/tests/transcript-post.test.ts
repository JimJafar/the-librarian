// Network ship for the auto-capture delta (Phase 2B / T-Pi): derive the
// /transcript URL from LIBRARIAN_MCP_URL and POST the payload with the bearer
// token in the HEADER only, redirect:"error". Transport-level tests run against
// a real localhost socket (the repo convention — see helpers/fake-server.ts), so
// the redirect refusal + header placement are exercised against actual HTTP.

import { afterEach, describe, expect, it } from "vitest";
import { deriveTranscriptUrl, postDelta } from "../extensions/librarian/transcript-post.js";
import { startFakeServer, type FakeServer } from "./helpers/fake-server.js";

let server: FakeServer | undefined;
afterEach(async () => {
  if (server) await server.close();
  server = undefined;
});

describe("deriveTranscriptUrl", () => {
  it("rewrites a /mcp endpoint to /transcript on the same origin", () => {
    expect(deriveTranscriptUrl("https://host.example/mcp")).toBe("https://host.example/transcript");
  });

  it("drops query + hash + path, keeping only origin/transcript", () => {
    expect(deriveTranscriptUrl("https://h.example/mcp?x=1#y")).toBe("https://h.example/transcript");
  });

  it("preserves a non-default port", () => {
    expect(deriveTranscriptUrl("http://127.0.0.1:8787/mcp")).toBe(
      "http://127.0.0.1:8787/transcript",
    );
  });

  it("returns null for an unusable / non-http(s) URL (caller fails soft)", () => {
    expect(deriveTranscriptUrl(undefined)).toBeNull();
    expect(deriveTranscriptUrl("")).toBeNull();
    expect(deriveTranscriptUrl("not a url")).toBeNull();
    expect(deriveTranscriptUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("postDelta (the network ship)", () => {
  it("POSTs JSON with the bearer token in the Authorization header only", async () => {
    server = await startFakeServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true, buffered: 2 }));
    });
    const payload = { conv_id: "s", harness: "pi", seq: 1, turns: [] };
    const ack = await postDelta(`${server.url}/transcript`, payload, "tok-secret");

    expect(ack).toEqual({ ok: true, status: 200, buffered: 2 });
    const req = server.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/transcript");
    expect(req.headers.authorization).toBe("Bearer tok-secret");
    expect(req.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(req.body)).toEqual(payload);
  });

  it("never puts the token in the URL", async () => {
    server = await startFakeServer((_req, res) => {
      res.writeHead(200);
      res.end("{}");
    });
    await postDelta(`${server.url}/transcript`, { seq: 1 }, "tok-secret");
    expect(server.requests[0]!.path).not.toContain("tok-secret");
  });

  it("returns ok:false on a non-2xx (caller holds seq, will retry) without throwing", async () => {
    server = await startFakeServer((_req, res) => {
      res.writeHead(500);
      res.end("nope");
    });
    const ack = await postDelta(`${server.url}/transcript`, { seq: 1 }, "tok");
    expect(ack.ok).toBe(false);
    expect(ack.status).toBe(500);
  });

  it("reports a gate-off 2xx as ok (the route 200s with accepted:false)", async () => {
    server = await startFakeServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: false, disabled: true }));
    });
    const ack = await postDelta(`${server.url}/transcript`, { seq: 1 }, "tok");
    expect(ack.ok).toBe(true);
    expect(ack.status).toBe(200);
  });

  it("refuses to follow a 3xx redirect (a 3xx must not carry the token cross-origin)", async () => {
    server = await startFakeServer((_req, res) => {
      res.writeHead(302, { location: "https://evil.example/steal" });
      res.end();
    });
    // redirect:"error" makes fetch reject — postDelta lets the caller's try/catch
    // treat it as "do not advance", so it propagates as a thrown error.
    await expect(postDelta(`${server.url}/transcript`, { seq: 1 }, "tok")).rejects.toThrow();
  });
});
