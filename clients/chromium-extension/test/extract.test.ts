// @vitest-environment jsdom
//
// Integration check: the REAL Defuddle browser build runs end-to-end against a
// real DOM and our wrapper returns a populated { title, content }.
//
// HONEST LIMITATION: Defuddle's browser build relies on layout + getComputedStyle
// to score and prune content, which jsdom only stubs. Under jsdom it therefore
// falls back to returning the whole body rather than a cleaned, Markdown-converted
// article. So this test asserts only what holds without a real engine — the title
// resolves and the article prose survives. The clean-Markdown / nav-and-ad-removal
// behaviour (SPIKE-A proved it server-side via defuddle/node) is verified in a
// real browser as the human's deferred load-unpacked step (see README).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractArticle } from "../src/lib/extract.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, "fixtures/article.html"), "utf8");

function documentFromHtml(source: string): Document {
  return new DOMParser().parseFromString(source, "text/html");
}

describe("extractArticle (real Defuddle browser build under jsdom)", () => {
  it("runs end-to-end and returns a non-empty title", () => {
    const extraction = extractArticle(documentFromHtml(html));
    expect(extraction.title.length).toBeGreaterThan(0);
    expect(extraction.title.toLowerCase()).toContain("quiet library");
  });

  it("returns content carrying the article prose", () => {
    const extraction = extractArticle(documentFromHtml(html));
    expect(extraction.content).toContain("A library is a machine for attention");
  });
});
