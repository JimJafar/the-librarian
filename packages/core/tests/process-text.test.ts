// Process a `text` capture into a vault note reference (ingest spec Task 5;
// criterion 14-text; D15). Drives the background write path directly against a
// real temp-dir store (vault + git) so the assertions are end-to-end on disk:
// the note lands at the D8 path with D13 frontmatter (and NO `source`), the log
// row flips to success, empty/emoji text falls back to `note-<date>`, the title
// derives from the first non-empty line (heading marker stripped), and two
// same-day notes with the SAME first line get distinct paths (D15 — never dedup).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  createLibrarianStore,
  deriveTextTitle,
  listRecent,
  processTextCapture,
  recordPending,
} from "@librarian/core";
import matter from "gray-matter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let store: LibrarianStore;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-ingest-text-"));
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

/** A pending row's id — the processor needs an existing row to transition. */
function pending(via: "extension" | "ios" | "android" = "ios"): string {
  return recordPending(store, { source: "text-capture", via });
}

function readVaultFile(relPath: string): string {
  return fs.readFileSync(path.join(dataDir, "vault", relPath), "utf8");
}

function rowFor(id: string) {
  return listRecent(store, 100).find((r) => r.id === id);
}

const today = new Date().toISOString().slice(0, 10);

describe("deriveTextTitle — first-line title derivation (D15)", () => {
  it("uses the first non-empty line", () => {
    expect(deriveTextTitle("Buy milk and eggs")).toBe("Buy milk and eggs");
  });

  it("skips leading blank lines and uses the first NON-empty line", () => {
    expect(deriveTextTitle("\n\n  \nReal first line\nsecond line")).toBe("Real first line");
  });

  it("strips a leading markdown heading marker", () => {
    expect(deriveTextTitle("# My Heading\nbody text")).toBe("My Heading");
    expect(deriveTextTitle("### Deep heading")).toBe("Deep heading");
  });

  it("truncates an overly long first line to a sane length", () => {
    const long = "a".repeat(200);
    expect(deriveTextTitle(long)).toHaveLength(80);
  });

  it("returns null for empty / whitespace-only text", () => {
    expect(deriveTextTitle("")).toBeNull();
    expect(deriveTextTitle("   \n\t  \n")).toBeNull();
  });
});

describe("processTextCapture — note write path (criterion 14-text)", () => {
  it("writes references/web/<date>-<slug>.md with first-line title, NO source, body=text, logs success", async () => {
    const id = pending();
    const result = await processTextCapture(
      store,
      { text: "Tuning the grand piano\nIt needs tuning twice a year.", via: "ios" },
      id,
    );

    const expectedPath = `references/web/${today}-tuning-the-grand-piano.md`;
    expect(result).toEqual({ status: "success", path: expectedPath });

    const raw = readVaultFile(expectedPath);
    const parsed = matter(raw);
    expect(parsed.data.title).toBe("Tuning the grand piano");
    expect(parsed.data.via).toBe("ios");
    // A text capture has NO URL → there must be NO `source` frontmatter key.
    expect("source" in parsed.data).toBe(false);
    expect(new Date(parsed.data.captured_at as string).toISOString()).not.toBe("Invalid Date");
    // The WHOLE text (both lines) is the body, not just the title line.
    expect(parsed.content).toContain("It needs tuning twice a year.");

    const row = rowFor(id);
    expect(row?.status).toBe("success");
    expect(row?.result_path).toBe(expectedPath);
  });

  it("strips a leading '# Heading' marker from the slug too", async () => {
    const id = pending();
    const result = await processTextCapture(
      store,
      { text: "# Sailing Guide\nbody", via: "ios" },
      id,
    );
    expect(result.path).toBe(`references/web/${today}-sailing-guide.md`);
  });

  it("is immediately searchable (lazy index, no build step)", async () => {
    const id = pending();
    await processTextCapture(
      store,
      { text: "Navigating sailboats across open ocean water under sail.", via: "ios" },
      id,
    );
    const hits = await store.searchReferences("sailing across the ocean");
    expect(hits.map((h) => h.id)).toContain(
      `references/web/${today}-navigating-sailboats-across-open-ocean-water-under-sail.md`,
    );
  });
});

describe("processTextCapture — empty/unicode fallback (criterion 14-text)", () => {
  it("empty/whitespace text falls back to note-<date>, never '<date>-.md'", async () => {
    const id = pending();
    const result = await processTextCapture(store, { text: "   \n\t \n", via: "ios" }, id);
    expect(result.path).toBe(`references/web/${today}-note-${today}.md`);
    expect(result.path).not.toMatch(/-\.md$/);
    expect(rowFor(id)?.status).toBe("success");
    expect(matter(readVaultFile(result.path!)).data.title).toBe(`note-${today}`);
  });

  it("an emoji/punctuation-only first line falls back to note-<date>", async () => {
    const id = pending();
    const result = await processTextCapture(store, { text: "🎉🎊 !!! ???", via: "ios" }, id);
    expect(result.path).toBe(`references/web/${today}-note-${today}.md`);
    expect(result.path).not.toMatch(/-\.md$/);
  });
});

describe("processTextCapture — never dedups (D15, criterion 14-text)", () => {
  it("two same-day captures with the SAME first line get DISTINCT paths; neither clobbers", async () => {
    const a = await processTextCapture(
      store,
      { text: "Meeting notes\nfirst capture", via: "ios" },
      pending(),
    );
    const b = await processTextCapture(
      store,
      { text: "Meeting notes\nsecond capture", via: "ios" },
      pending(),
    );

    expect(a.path).toBe(`references/web/${today}-meeting-notes.md`);
    expect(b.path).not.toBe(a.path);
    expect(b.path).toMatch(new RegExp(`^references/web/${today}-meeting-notes-[0-9a-f]{6}\\.md$`));

    // Both survive: neither write clobbered the other.
    expect(readVaultFile(a.path!)).toContain("first capture");
    expect(readVaultFile(b.path!)).toContain("second capture");
  });
});
