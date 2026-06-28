import type { Extraction, IngestPayload } from "./types.js";

/**
 * Build the exact `/ingest` request body for an extension capture (spec
 * criterion 23 / D26). Pure: an extraction result + the active tab URL in, the
 * server contract `{ url, title, content, via, site?, byline? }` out.
 *
 * `site`/`byline` are included ONLY when the extraction surfaced a non-empty,
 * trimmed value — never as `""` or `null` — so the server's optional-frontmatter
 * fields (D13) stay clean. `title` falls back to an empty string here; the
 * SERVER owns the empty/unicode-title fallback (criterion 14/15), so the client
 * must not invent a placeholder that would defeat it.
 */
export function buildPayload(extraction: Extraction, url: string): IngestPayload {
  const site = extraction.site?.trim();
  const byline = extraction.byline?.trim();
  return {
    url,
    title: extraction.title.trim(),
    content: extraction.content,
    via: "extension",
    ...(site ? { site } : {}),
    ...(byline ? { byline } : {}),
  };
}
