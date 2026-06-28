// Process a `content` capture into a vault reference (ingest spec Task 4;
// criteria 11–15). Drives the background write path directly against a real
// temp-dir store (vault + git) so the assertions are end-to-end on disk: the
// file lands at the D8 path with D13 frontmatter, the log row flips to success,
// the same URL overwrites in place (D6/D11), different URLs that slug-collide
// get distinct paths (D8), and an empty/emoji title falls back (criterion 14).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  createLibrarianStore,
  listRecent,
  processContentCapture,
  recordPending,
  slugifyTitle,
} from "@librarian/core";
import matter from "gray-matter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let store: LibrarianStore;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-ingest-content-"));
  store = createLibrarianStore({ dataDir });
});
afterEach(() => {
  try {
    store.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** The pending row's id — the processor needs an existing row to transition. */
function pending(url: string, via: "extension" | "ios" | "android" = "extension"): string {
  return recordPending(store, { source: url, via });
}

function readVaultFile(relPath: string): string {
  return fs.readFileSync(path.join(dataDir, "vault", relPath), "utf8");
}

function rowFor(id: string) {
  return listRecent(store, 100).find((r) => r.id === id);
}

const today = new Date().toISOString().slice(0, 10);

describe("processContentCapture — slug derivation (D8, criterion 14)", () => {
  it("slugs a normal title", () => {
    expect(slugifyTitle("Hello, World!")).toBe("hello-world");
  });

  it("falls back to 'untitled' for an empty title", () => {
    expect(slugifyTitle("")).toBe("untitled");
    expect(slugifyTitle("   ")).toBe("untitled");
  });

  it("falls back to 'untitled' for an emoji/CJK-only title (never an empty stem)", () => {
    expect(slugifyTitle("🎉🎊")).toBe("untitled");
    expect(slugifyTitle("日本語")).toBe("untitled");
  });
});

describe("processContentCapture — content write path (criteria 11, 15)", () => {
  it("writes references/web/<date>-<slug>.md with D13 frontmatter + body, logs success", async () => {
    const url = "https://example.com/the-grand-piano";
    const id = pending(url);
    const result = await processContentCapture(
      store,
      {
        content: "## Tuning\nThe grand piano needs tuning twice a year.",
        url,
        title: "The Grand Piano",
        via: "extension",
      },
      id,
    );

    const expectedPath = `references/web/${today}-the-grand-piano.md`;
    expect(result).toEqual({ status: "success", path: expectedPath });

    const raw = readVaultFile(expectedPath);
    const parsed = matter(raw);
    expect(parsed.data.title).toBe("The Grand Piano");
    expect(parsed.data.source).toBe(url);
    expect(parsed.data.via).toBe("extension");
    // captured_at is an ISO instant (gray-matter may re-read it as a Date).
    expect(new Date(parsed.data.captured_at as string).toISOString()).not.toBe("Invalid Date");
    expect(parsed.content).toContain("The grand piano needs tuning twice a year.");

    const row = rowFor(id);
    expect(row?.status).toBe("success");
    expect(row?.result_path).toBe(expectedPath);
  });

  it("is immediately searchable (lazy index, no build step)", async () => {
    const url = "https://example.com/sailing-guide";
    const id = pending(url);
    await processContentCapture(
      store,
      {
        content: "Navigating sailboats across open ocean water under sail.",
        url,
        title: "Sailing Guide",
        via: "extension",
      },
      id,
    );
    const hits = await store.searchReferences("sailing across the ocean");
    expect(hits.map((h) => h.id)).toContain(`references/web/${today}-sailing-guide.md`);
  });
});

describe("processContentCapture — dedup overwrite (D6/D11, criterion 12)", () => {
  it("re-capturing the same URL overwrites the same path and refreshes content", async () => {
    const url = "https://example.com/news?utm_source=twitter#section";
    const first = await processContentCapture(
      store,
      { content: "First version of the article.", url, title: "Breaking News", via: "extension" },
      pending(url),
    );
    const firstPath = first.path!;
    expect(firstPath).toBe(`references/web/${today}-breaking-news.md`);

    // A second capture of the same (normalized) URL — tracking param + fragment
    // differ, but they normalize away, so the dedup index matches.
    const second = await processContentCapture(
      store,
      {
        content: "Updated version with new details.",
        url: "https://example.com/news?utm_source=newsletter",
        title: "Breaking News (Updated)",
        via: "extension",
      },
      pending("https://example.com/news?utm_source=newsletter"),
    );

    // Same path (original date prefix kept), content refreshed.
    expect(second.path).toBe(firstPath);
    const raw = readVaultFile(firstPath);
    expect(raw).toContain("Updated version with new details.");
    expect(raw).not.toContain("First version of the article.");
  });
});

describe("processContentCapture — same-day slug collision (D8, criterion 13)", () => {
  it("gives two DIFFERENT URLs that slug identically distinct paths; neither clobbers", async () => {
    const urlA = "https://a.example.com/post";
    const urlB = "https://b.example.com/post";
    const a = await processContentCapture(
      store,
      { content: "Content from site A.", url: urlA, title: "Same Title", via: "extension" },
      pending(urlA),
    );
    const b = await processContentCapture(
      store,
      { content: "Content from site B.", url: urlB, title: "Same Title", via: "extension" },
      pending(urlB),
    );

    expect(a.path).toBe(`references/web/${today}-same-title.md`);
    expect(b.path).not.toBe(a.path);
    expect(b.path).toMatch(new RegExp(`^references/web/${today}-same-title-[0-9a-f]{6}\\.md$`));

    // Both survive: neither write clobbered the other.
    expect(readVaultFile(a.path!)).toContain("Content from site A.");
    expect(readVaultFile(b.path!)).toContain("Content from site B.");
  });
});

describe("processContentCapture — title fallback (criterion 14)", () => {
  it("an emoji-only title produces a sane fallback path, not '<date>-.md'", async () => {
    const url = "https://example.com/emoji";
    const id = pending(url);
    const result = await processContentCapture(
      store,
      { content: "A reference with no usable title.", url, title: "🎉🎊", via: "extension" },
      id,
    );
    expect(result.path).toBe(`references/web/${today}-untitled.md`);
    expect(result.path).not.toMatch(/-\.md$/);
    expect(rowFor(id)?.status).toBe("success");
  });
});
