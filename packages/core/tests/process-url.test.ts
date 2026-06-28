// End-to-end tests for the `url`-capture pipeline (ingest spec Task 6;
// criteria 11-url/16/17/18/3-extractcap; D23). The SSRF guard is relaxed for the
// LOOPBACK fixture server only (createFetchGuard({ allowLoopback: true })) — every
// OTHER private range stays blocked, so the "redirect to a blocked IP is refused"
// case is meaningful. The fetch goes through the REAL fetchHtml (pinning, manual
// redirects, body cap, content-type gate); only the guard is relaxed.

import fs from "node:fs";
import http from "node:http";
import { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  createFetchGuard,
  createLibrarianStore,
  listRecent,
  processUrlCapture,
  recordPending,
} from "@librarian/core";
import matter from "gray-matter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let store: LibrarianStore;
let dataDir = "";
let server: http.Server;
let base = ""; // http://127.0.0.1:<port>

const ARTICLE_HTML = `<!doctype html>
<html lang="en">
<head>
  <title>The Reading Room Manifesto</title>
  <meta name="author" content="Ada Lovelace" />
  <meta property="og:site_name" content="Example Journal" />
</head>
<body>
  <nav>Home About Contact</nav>
  <article>
    <h1>The Reading Room Manifesto</h1>
    <p>A library is a place where the quiet accumulation of knowledge becomes
    something you can walk through. This first paragraph establishes the theme
    with enough words that the content scorer keeps it.</p>
    <p>The second paragraph continues the argument about durable memory and the
    importance of preserving references in a calm, editorial system that favours
    paper and ink over noise and clutter.</p>
    <p>A third paragraph drives the point home so the extractor has a clear,
    high-scoring block of prose to select as the main content of the page.</p>
  </article>
  <footer>Copyright nobody</footer>
</body>
</html>`;

const SECOND_HTML = ARTICLE_HTML.replace("The Reading Room Manifesto", "The Second Reading Room");

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-ingest-url-"));
  store = createLibrarianStore({ dataDir });
  server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/article")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(ARTICLE_HTML);
    } else if (url.startsWith("/second")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(SECOND_HTML);
    } else if (url.startsWith("/redirect-to-second")) {
      res.writeHead(302, { location: "/second" });
      res.end();
    } else if (url.startsWith("/redirect-to-blocked")) {
      res.writeHead(302, { location: "http://10.0.0.1/secret" });
      res.end();
    } else if (url.startsWith("/pdf")) {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end("%PDF-1.4 not really html");
    } else {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<html><body>nope</body></html>");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    store.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Relaxed guard: loopback fixture allowed, every other private range still blocked. */
const loopbackGuard = createFetchGuard({ allowLoopback: true });

function pending(url: string): string {
  return recordPending(store, { source: url, via: "ios" });
}

function rowFor(id: string) {
  return listRecent(store, 100).find((r) => r.id === id);
}

describe("processUrlCapture — happy path (criteria 11-url, 15, 17)", () => {
  it("fetches, extracts via Defuddle, writes a reference, logs success, is searchable", async () => {
    const url = `${base}/article`;
    const id = pending(url);
    const result = await processUrlCapture(store, { url, via: "ios" }, id, {
      guard: loopbackGuard,
    });

    expect(result.status).toBe("success");
    expect(result.path).toMatch(
      /^references\/web\/\d{4}-\d{2}-\d{2}-the-reading-room-manifesto\.md$/,
    );

    const row = rowFor(id);
    expect(row?.status).toBe("success");
    expect(row?.result_path).toBe(result.path);

    const raw = fs.readFileSync(path.join(dataDir, "vault", result.path!), "utf8");
    const parsed = matter(raw);
    expect(parsed.data.title).toBe("The Reading Room Manifesto");
    expect(parsed.data.source).toBe(url);
    expect(parsed.data.via).toBe("ios");
    expect(parsed.data.byline).toBe("Ada Lovelace");
    expect(parsed.content).toContain("quiet accumulation of knowledge");

    const hits = await store.searchReferences("quiet accumulation of knowledge", 5);
    expect(hits.map((h) => h.id)).toContain(result.path);
  });
});

describe("processUrlCapture — redirects (criterion 18)", () => {
  it("follows a legit redirect to a second allowed path and writes the target", async () => {
    const url = `${base}/redirect-to-second`;
    const id = pending(url);
    const result = await processUrlCapture(store, { url, via: "ios" }, id, {
      guard: loopbackGuard,
    });

    expect(result.status).toBe("success");
    const raw = fs.readFileSync(path.join(dataDir, "vault", result.path!), "utf8");
    expect(matter(raw).data.title).toBe("The Second Reading Room");
    expect(rowFor(id)?.status).toBe("success");
  });

  it("refuses a redirect whose Location resolves to a blocked IP, logs failure, writes nothing", async () => {
    const url = `${base}/redirect-to-blocked`;
    const id = pending(url);
    const result = await processUrlCapture(store, { url, via: "ios" }, id, {
      guard: loopbackGuard,
    });

    expect(result.status).toBe("failed");
    const row = rowFor(id);
    expect(row?.status).toBe("failed");
    expect(row?.result_path).toBeUndefined();
    expect(fs.existsSync(path.join(dataDir, "vault", "references", "web"))).toBe(false);
  });
});

describe("processUrlCapture — blocked target writes nothing (criterion 16)", () => {
  it("refuses a direct private/metadata target and logs a failed row", async () => {
    // Real guard (no loopback relaxation) — the metadata literal is blocked.
    const url = "http://169.254.169.254/latest/meta-data/";
    const id = pending(url);
    const result = await processUrlCapture(store, { url, via: "ios" }, id);

    expect(result.status).toBe("failed");
    expect(rowFor(id)?.status).toBe("failed");
    expect(fs.existsSync(path.join(dataDir, "vault", "references", "web"))).toBe(false);
  });
});

describe("processUrlCapture — content-type gate (criterion 17)", () => {
  it("treats a non-HTML (application/pdf) response as a logged failure, no write", async () => {
    const url = `${base}/pdf`;
    const id = pending(url);
    const result = await processUrlCapture(store, { url, via: "ios" }, id, {
      guard: loopbackGuard,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/non-HTML/i);
    expect(rowFor(id)?.status).toBe("failed");
  });
});

describe("processUrlCapture — extracted-markdown cap (criterion 3-extractcap)", () => {
  it("fails (no write) when the extracted markdown exceeds the cap", async () => {
    const url = `${base}/article`;
    const id = pending(url);
    // A 1-byte cap forces the over-cap branch on any real article.
    const result = await processUrlCapture(store, { url, via: "ios" }, id, {
      guard: loopbackGuard,
      maxExtractedBytes: 1,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/exceeds/i);
    expect(rowFor(id)?.status).toBe("failed");
    expect(fs.existsSync(path.join(dataDir, "vault", "references", "web"))).toBe(false);
  });
});
