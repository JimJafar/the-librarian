// Process a `url` capture into a vault reference (ingest spec Task 6;
// criteria 11-url/16/17/18/3-extractcap; decisions D1/D10/D23).
//
// A `url`-only capture is the mobile share-sheet path: the body is just
// `{ url, via }`, so unlike the `content` branch (process-content.ts) the SERVER
// does the extraction. The pipeline is:
//
//   1. fetchHtml() — SSRF-guarded, socket-pinned, redirect-revalidating,
//      body-capped, text/html-gated fetch (fetch-html.ts + url-guard.ts).
//   2. Defuddle(html, url, { markdown: true }) — clean markdown + D13 metadata.
//      `useAsync: false` so Defuddle's own extractors NEVER make outbound network
//      calls (those would bypass our SSRF guard).
//   3. cap the extracted markdown (~1 MB, criterion 3-extractcap).
//   4. hand `{ content, url, title, site, byline, via }` to processContentCapture
//      for the write + dedup-overwrite + markSuccess (Task 4 already owns that).
//
// Like the other branches it runs in the BACKGROUND, after /ingest returned its
// 202 (D22): fail-soft (never throws — every failure is caught and recorded via
// markFailed) and directly unit-testable (a plain store + body + log-id, plus an
// injectable guard/fetch seam so the happy path can run against a loopback
// fixture server with the guard relaxed).

import { Defuddle } from "defuddle/node";
import { type FetchedHtml, fetchHtml } from "./fetch-html.js";
import { type IngestVia, markFailed } from "./ingest-log.js";
import {
  type ContentCaptureResult,
  type ContentCaptureStore,
  processContentCapture,
} from "./process-content.js";
import { type FetchGuard, createFetchGuard } from "./url-guard.js";

/** A `url`-branch capture: a bare URL plus which client produced it. */
export interface UrlCaptureInput {
  /** The source URL to fetch + extract — the dedup key and frontmatter `source`. */
  url: string;
  /** Which client produced the capture (D13 frontmatter `via`). */
  via: IngestVia;
}

/**
 * Injectable seams + tunables. Production passes nothing (real guard, real
 * fetch); a test injects a relaxed guard (allowLoopback) and/or points fetch at a
 * loopback fixture server, and can lower the extracted-markdown cap.
 */
export interface UrlCaptureDeps {
  /** The SSRF guard (default: the real deny-list guard). */
  guard?: FetchGuard;
  /** The HTML fetcher (default: {@link fetchHtml}); injectable for fixtures. */
  fetchHtmlImpl?: (rawUrl: string, opts: { guard: FetchGuard }) => Promise<FetchedHtml>;
  /** Max extracted-markdown bytes before the capture is failed (default ~1 MB). */
  maxExtractedBytes?: number;
}

/** ~1 MB cap on the EXTRACTED markdown (criterion 3-extractcap, distinct from the 2 MB request-body cap). */
const DEFAULT_MAX_EXTRACTED_BYTES = 1024 * 1024;

export async function processUrlCapture(
  store: ContentCaptureStore,
  input: UrlCaptureInput,
  id: string,
  deps: UrlCaptureDeps = {},
): Promise<ContentCaptureResult> {
  try {
    const guard = deps.guard ?? createFetchGuard();
    const fetcher = deps.fetchHtmlImpl ?? ((u, o) => fetchHtml(u, o));

    // 1. SSRF-guarded fetch. Throws on any guard refusal / non-2xx / non-HTML /
    //    oversize / timeout — caught by the outer try and logged (no write).
    const { html } = await fetcher(input.url, { guard });

    // 2. Extract. Defuddle is async; a parse throw is a logged failure, not a
    //    crash. useAsync:false keeps Defuddle from making its own network calls.
    let title = "";
    let site = "";
    let byline = "";
    let content = "";
    try {
      const parsed = await Defuddle(html, input.url, { markdown: true, useAsync: false });
      content = (parsed.content ?? "").trim();
      title = (parsed.title ?? "").trim();
      site = (parsed.site ?? "").trim();
      byline = (parsed.author ?? "").trim();
    } catch (error) {
      const message = `Extraction failed: ${error instanceof Error ? error.message : String(error)}`;
      markFailed(store, id, message);
      return { status: "failed", error: message };
    }

    // Empty extraction → logged failure, no write (criterion 18).
    if (!content) {
      const message = "Extraction produced no content";
      markFailed(store, id, message);
      return { status: "failed", error: message };
    }

    // 3. Extracted-markdown cap (criterion 3-extractcap): a logged failure, NOT a
    //    synchronous 413 (it is discovered post-202).
    const maxExtracted = deps.maxExtractedBytes ?? DEFAULT_MAX_EXTRACTED_BYTES;
    if (Buffer.byteLength(content, "utf8") > maxExtracted) {
      const message = `Extracted markdown exceeds the ${Math.round(maxExtracted / (1024 * 1024))} MB cap`;
      markFailed(store, id, message);
      return { status: "failed", error: message };
    }

    // 4. Hand off to the shared write+dedup path (Task 4): it writes the
    //    reference, dedup-overwrites by URL, and flips the log row to success.
    return await processContentCapture(
      store,
      {
        content,
        url: input.url,
        ...(title ? { title } : {}),
        ...(site ? { site } : {}),
        ...(byline ? { byline } : {}),
        via: input.via,
      },
      id,
    );
  } catch (error) {
    // Fail-soft (D22): record a redacted failure and return it; the background
    // caller never sees a throw.
    const message = error instanceof Error ? error.message : String(error);
    markFailed(store, id, message);
    return { status: "failed", error: message };
  }
}
