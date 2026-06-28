import Defuddle from "defuddle";
import type { Extraction } from "./types.js";

/**
 * Run Defuddle's browser build over a live `Document` and return the fields the
 * `/ingest` contract needs (spec criterion 23, mirrors SPIKE-A). With
 * `{ markdown: true }` Defuddle returns the cleaned article body as Markdown in
 * `content`, plus rich metadata (`title`, `site`, `author`) we map to D13's
 * frontmatter fields.
 *
 * Pure of any network or chrome.* API — it only reads the DOM — so it is the one
 * piece of the content script that is directly unit-testable under jsdom.
 *
 * @param doc the live page document (the content script passes `document`)
 */
export function extractArticle(doc: Document): Extraction {
  const result = new Defuddle(doc, { markdown: true }).parse();

  const title = (result.title ?? "").trim();
  const content = result.content ?? "";
  const site = (result.site ?? "").trim();
  const byline = (result.author ?? "").trim();

  return {
    title,
    content,
    ...(site ? { site } : {}),
    ...(byline ? { byline } : {}),
  };
}
