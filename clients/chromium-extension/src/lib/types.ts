// Shared types for the capture flow. Kept dependency-free so the pure logic
// modules (payload, server-url, send) and the browser glue (content-script,
// background, options, popup) agree on one contract.

/** What the content script's Defuddle pass yields from the live DOM. */
export interface Extraction {
  title: string;
  /** Article body as Markdown (Defuddle `{ markdown: true }`). */
  content: string;
  /** Publication / site name, when Defuddle could determine it. */
  site?: string;
  /** Author line, when Defuddle could determine it. */
  byline?: string;
}

/**
 * The exact JSON body POSTed to `<serverUrl>/ingest` for an extension capture.
 * `via` is always `"extension"`; `site`/`byline` are omitted entirely when the
 * extraction did not surface them (never sent as empty strings or `null`).
 */
export interface IngestPayload {
  url: string;
  title: string;
  content: string;
  via: "extension";
  site?: string;
  byline?: string;
}

/** Persisted extension configuration (server URL + capture token). */
export interface CaptureConfig {
  serverUrl: string;
  token: string;
}

/** A user-facing outcome of a capture attempt, mapped from the server response. */
export type SendKind =
  | "queued"
  | "not-configured"
  | "unauthorized"
  | "forbidden"
  | "too-large"
  | "rate-limited"
  | "bad-request"
  | "server-error"
  | "network-error";

export interface SendResult {
  ok: boolean;
  kind: SendKind;
  /** A human-readable, teaching status line for the popup/badge. */
  message: string;
  /** The ingest-log id returned on a 202, when present. */
  id?: string;
}

// ---------- runtime message envelopes (popup ⇄ background ⇄ content) ----------

/** popup → background: clip the active tab. */
export interface ClipRequest {
  type: "CLIP";
}

/** background → content script: run Defuddle on the live document. */
export interface ExtractRequest {
  type: "EXTRACT";
}

/** content script → background: the extraction result (or an error string). */
export interface ExtractResponse {
  type: "EXTRACTION";
  extraction?: Extraction;
  error?: string;
}

export type RuntimeMessage = ClipRequest | ExtractRequest | ExtractResponse;
