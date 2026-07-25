// `the-librarian refs add <url>` — spec 073 T3 (SC 3, 4, 8).
//
// This is wiring, not new capability: the SSRF-hardened fetch → Defuddle
// extraction → slug → dedup → write → capture-log pipeline already existed and
// was reachable only through `POST /ingest` with a clipper token. The CLI is a
// second handle on the same engine.
//
// Two things have to be true and are easy to get wrong:
//   1. The guard still applies. A CLI caller must not be a way around the SSRF
//      deny-list — so the refusal path is tested END TO END through runCli with
//      the REAL guard, not an injected one.
//   2. A failed capture is a non-zero exit. processUrlCapture is fail-soft by
//      design (it returns {status:"failed"} rather than throwing, because it
//      normally runs in a background turn after /ingest has already 202'd), so
//      the command has to translate that into a real CLI failure instead of
//      cheerfully reporting success.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withStore } from "../../../test/helpers.js";
import { addUrlReference } from "../src/commands/refs-add.js";
import { runCli } from "../src/runtime.js";

const HTML = `<!doctype html><html><head><title>Deploy policy</title></head>
<body><article><h1>Deploy policy</h1><p>Never deploy on a Friday afternoon.</p></article></body></html>`;

/** A fetch stub standing in for the network; the guard is bypassed explicitly. */
const stubFetch = (html = HTML) => ({
  guard: { assertFetchable: () => {} } as never,
  fetchHtmlImpl: async () => ({ html, finalUrl: "https://example.com/deploy" }) as never,
});

const vaultFiles = (dataDir: string, rel: string): string[] => {
  const dir = path.join(dataDir, "vault", rel);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, encoding: "utf8" }) as string[];
};

describe("refs add <url> (spec 073 SC 3)", () => {
  it("fetches, extracts and files the page under references/web/", async () => {
    await withStore(async (store, dataDir) => {
      const result = await addUrlReference(store, "https://example.com/deploy", stubFetch());

      expect(result.exitCode).toBe(0);
      const filed = vaultFiles(dataDir, "references/web");
      expect(filed).toHaveLength(1);
      expect(filed[0]).toMatch(/^\d{4}-\d{2}-\d{2}-.*\.md$/);

      const doc = fs.readFileSync(path.join(dataDir, "vault", "references/web", filed[0]!), "utf8");
      expect(doc).toContain("Never deploy on a Friday afternoon.");
      expect(doc).toContain("via: cli");
      expect(doc).toContain("https://example.com/deploy");
    });
  });

  it("reports the path it filed", async () => {
    await withStore(async (store) => {
      const result = await addUrlReference(store, "https://example.com/deploy", stubFetch());
      expect(result.stdout).toMatch(/references\/web\/.*\.md/);
    });
  });

  it("records the capture in the ingest log, like any other capture (SC 8)", async () => {
    await withStore(async (store) => {
      await addUrlReference(store, "https://example.com/deploy", stubFetch());

      const rows = store.listSettings().filter((s) => s.key.startsWith("ingest_log:"));
      expect(rows).toHaveLength(1);
      const record = JSON.parse(store.getSetting(rows[0]!.key)!) as {
        via: string;
        status: string;
      };
      expect(record.via).toBe("cli");
      expect(record.status).toBe("success");
    });
  });
});

describe("refs add <url> — the guard still applies (spec 073 SC 4)", () => {
  // The REAL guard — no injected seam. A CLI caller must not become a way
  // around the SSRF deny-list. Asserting the guard's OWN message matters:
  // without it these pass for any failure at all, including the command simply
  // not recognising the input.
  it.each([
    ["loopback", "http://127.0.0.1:1/secret", "127.0.0.1"],
    ["the cloud metadata endpoint", "http://169.254.169.254/latest/meta-data", "169.254.169.254"],
  ])("refuses %s and writes nothing", async (_label, url, host) => {
    await withStore(async (store, dataDir) => {
      const result = await runCli(["refs", "add", url], store);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toMatch(/private\/blocked address/);
      expect(result.stdout).toContain(host);
      expect(vaultFiles(dataDir, "references/web")).toHaveLength(0);
    });
  });

  it("refuses a non-HTTP scheme by NAMING the scheme, not by claiming the file is missing", async () => {
    await withStore(async (store, dataDir) => {
      const result = await runCli(["refs", "add", "file:///etc/passwd"], store);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toMatch(/unsupported scheme/);
      expect(result.stdout).not.toMatch(/not found/);
      expect(vaultFiles(dataDir, "references/web")).toHaveLength(0);
    });
  });

  it("exits non-zero when the capture fails, rather than reporting success", async () => {
    await withStore(async (store) => {
      const result = await addUrlReference(store, "https://example.com/deploy", {
        guard: { assertFetchable: () => {} } as never,
        fetchHtmlImpl: async () => {
          throw new Error("upstream exploded");
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toMatch(/could not|failed/i);
    });
  });
});
