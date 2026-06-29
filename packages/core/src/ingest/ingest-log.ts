// Ingest log + URL→path dedup index (reference-ingest spec D7/D11/D20/D24/D25).
//
// Every reference-capture attempt (browser extension / mobile share → /ingest)
// is recorded as ONE JSON row in the settings sidecar — NOT a relational DB
// (there is no SQLite here). We mirror the agent-tokens.ts pattern exactly: a
// `KEY_PREFIX` namespace, one JSON record per key, over a `SettingsLike` store.
//
// The log does double duty. Operationally (D7) the dashboard reads it to surface
// failures so the user can revisit a URL and capture manually. Structurally
// (D11) it IS the URL→path dedup index: a `pending` row is written synchronously
// before any background fetch (D22) so a crash between accept and completion
// still leaves a recorded attempt, and `lookupByUrl` lets a re-capture of the
// same article overwrite the existing file (D6) instead of minting a duplicate.
//
// Two privacy rules bind this module. The lookup key is a NORMALIZED url (D20) —
// lowercase host, no #fragment, no trailing slash, tracking params dropped — so
// the same article shared from different sources dedups to one entry. And every
// stored `source`/`error` is run through `redactSecrets` BEFORE it is persisted
// (D25): a `user:pass@host` capture URL or an upstream-auth error must never hit
// disk in plaintext.

import { createHash, randomBytes } from "node:crypto";
import { redactSecrets } from "../grooming-redaction.js";

const KEY_PREFIX = "ingest_log:";

/**
 * Retention cap (issue #423). The log shares the settings sidecar, which is read
 * and rewritten wholesale on every op — so unbounded growth makes every capture
 * (and every other settings write) O(n) and the dashboard's listRecent / dedup
 * lookups O(n²). Keep only the most-recent N attempts, pruning older rows on
 * write. Trade-off: dedup (`lookupByUrl`) only "remembers" the last N URLs — a
 * re-capture of an older URL mints a fresh reference instead of overwriting,
 * which is acceptable (dedup is best-effort).
 */
const MAX_LOG_ROWS = 100;

/**
 * Lifecycle of a capture attempt. `pending` is written synchronously at accept
 * time (D22); the background worker transitions it to `success` (with a
 * `result_path`) or `failed` (with a redacted `error`). Only `success` carries a
 * usable path, so only `success` rows satisfy a dedup lookup.
 */
export type IngestStatus = "pending" | "success" | "failed";

/** Which capture client produced the attempt (mirrors the D13 frontmatter `via`). */
export type IngestVia = "extension" | "ios" | "android";

const INGEST_VIAS: readonly IngestVia[] = ["extension", "ios", "android"];

/**
 * Tracking query params dropped during URL normalization (D20). Anything whose
 * name starts `utm_` is dropped too — see `normalizeUrl`. These are the params
 * that vary by share source without changing the article, so keeping them would
 * defeat dedup.
 */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  "fbclid",
  "gclid",
  "mc_eid",
  "mc_cid",
  "igshid",
  "ref",
]);

type SettingsLike = {
  setSetting: (key: string, value: string, options?: { secret?: boolean }) => void;
  getSetting: (key: string) => string | null;
  deleteSetting?: (key: string) => void;
  listSettings: () => { key: string }[];
};

/**
 * One capture attempt. `error`/`result_path` are absent until the background
 * worker transitions the row (a `pending` row has neither). `source` and `error`
 * are stored already-redacted (D25).
 */
export interface IngestLogRecord {
  id: string;
  source: string;
  via: IngestVia;
  status: IngestStatus;
  error?: string;
  result_path?: string;
  /**
   * The dedup key (D11/D20): a SHA-256 of the normalized URL, or absent when the
   * source isn't a URL (a raw-text capture). It is deliberately NOT the `source`
   * field: `source` is redacted for display (D25), and redaction rewrites
   * `?token=`/`?api_key=`/basic-auth — so keying dedup on the redacted string
   * would break overwrite-on-re-capture (D6) for any credential-bearing URL.
   * Hashing the (cred-stripped, see `normalizeUrl`) key also keeps a `?token=`
   * query secret off disk entirely.
   */
  url_key?: string;
  created_at: string;
}

/**
 * Normalize a URL for the dedup key (D20): lowercase host (the URL parser does
 * this), STRIP userinfo (`user:pass@` — credentials never belong in the key, and
 * stripping them lets a credentialed and a clean capture of the same page dedup),
 * strip the `#fragment`, drop tracking query params (`utm_*` plus the fixed
 * `TRACKING_PARAMS` set), SORT the remaining params (so `?a=1&b=2` and `?b=2&a=1`
 * dedup), and strip a single trailing slash. Returns null for an unparseable
 * input so callers fail soft rather than throw on junk.
 */
function normalizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  url.hash = "";
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith("utm_") || TRACKING_PARAMS.has(lower)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  // Strip a trailing slash on a non-root path so `/article/` and `/article`
  // dedup; the root `/` is left alone (it has no meaningful slash to strip).
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}

/**
 * The dedup key for a source: a SHA-256 of its normalized URL, or null when the
 * source isn't a URL. Hashing (not the raw normalized URL) is what keeps a
 * `?token=` query secret off disk while still letting the same URL dedup to one
 * key.
 */
function urlKey(source: string): string | null {
  const normalized = normalizeUrl(source);
  if (!normalized) return null;
  return createHash("sha256").update(normalized).digest("hex");
}

function readRecord(store: SettingsLike, id: string): IngestLogRecord | null {
  const raw = store.getSetting(KEY_PREFIX + id);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as IngestLogRecord;
  } catch {
    // A malformed row is treated as absent rather than crashing a list/lookup;
    // the ingest path must never throw out of a background turn (fail-soft).
    return null;
  }
}

function allRecords(store: SettingsLike): IngestLogRecord[] {
  const records: IngestLogRecord[] = [];
  for (const { key } of store.listSettings()) {
    if (!key.startsWith(KEY_PREFIX)) continue;
    const record = readRecord(store, key.slice(KEY_PREFIX.length));
    if (record) records.push(record);
  }
  return records;
}

/** Newest-first by ISO `created_at` (descending string compare on ISO is correct). */
function byNewestFirst(a: IngestLogRecord, b: IngestLogRecord): number {
  return b.created_at.localeCompare(a.created_at);
}

/**
 * Drop capture rows beyond the {@link MAX_LOG_ROWS} most recent (oldest first) —
 * the retention bound (issue #423). Called after each new attempt is written, so
 * the row count (and thus the per-op scan/rewrite cost) stays bounded. No-op if
 * the store can't delete.
 */
function pruneLog(store: SettingsLike): void {
  if (!store.deleteSetting) return;
  const stale = allRecords(store).sort(byNewestFirst).slice(MAX_LOG_ROWS);
  for (const record of stale) {
    store.deleteSetting(KEY_PREFIX + record.id);
  }
}

/**
 * Record a `pending` capture attempt and return its id. Written synchronously
 * before any background fetch (D22) so a crash mid-capture still leaves a
 * recorded attempt the dashboard can surface. `source` is redacted before it is
 * persisted (D25).
 */
export function recordPending(
  store: SettingsLike,
  input: { source: string; via: IngestVia },
): string {
  const source = (input.source ?? "").trim();
  if (!source) throw new Error("source is required");
  if (!INGEST_VIAS.includes(input.via)) {
    throw new Error(`Unknown ingest via: ${input.via}. Expected one of: ${INGEST_VIAS.join(", ")}`);
  }

  const id = randomBytes(9).toString("base64url");
  // Compute the dedup key from the RAW source (before redaction); store the
  // source itself redacted (D25). The two must not be conflated — see url_key.
  const key = urlKey(source);
  const record: IngestLogRecord = {
    id,
    source: redactSecrets(source).redacted,
    via: input.via,
    status: "pending",
    ...(key ? { url_key: key } : {}),
    created_at: new Date().toISOString(),
  };
  store.setSetting(KEY_PREFIX + id, JSON.stringify(record));
  pruneLog(store);
  return id;
}

/**
 * Transition an existing row to `success` with the vault path it produced.
 * Returns false (no-op) if the id is unknown — the caller decides whether a
 * missing row is an error.
 */
export function markSuccess(store: SettingsLike, id: string, resultPath: string): boolean {
  const record = readRecord(store, id);
  if (!record) return false;
  record.status = "success";
  record.result_path = resultPath;
  delete record.error;
  store.setSetting(KEY_PREFIX + id, JSON.stringify(record));
  return true;
}

/**
 * Transition an existing row to `failed`, storing a REDACTED error (D25) — a
 * fetch error can echo a `user:pass@host` URL or an upstream `Authorization`
 * header, neither of which may hit disk in plaintext. Returns false if the id is
 * unknown.
 */
export function markFailed(store: SettingsLike, id: string, error: string): boolean {
  const record = readRecord(store, id);
  if (!record) return false;
  record.status = "failed";
  record.error = redactSecrets(error ?? "").redacted;
  delete record.result_path;
  store.setSetting(KEY_PREFIX + id, JSON.stringify(record));
  return true;
}

/**
 * Dedup lookup (D11/D20): return the `result_path` of a prior SUCCESSFUL capture
 * whose normalized URL matches `url`, else null. Only `success` rows qualify — a
 * `pending` or `failed` row has no usable path, so a re-capture after a failure
 * correctly mints a fresh attempt rather than overwriting nothing. When several
 * successes share a normalized URL (a re-captured article), the newest wins.
 */
export function lookupByUrl(store: SettingsLike, url: string): string | null {
  const target = urlKey(url);
  if (!target) return null;
  // Match on the stored `url_key` hash — NEVER by re-normalizing the redacted
  // `source` (which would miss any credential-bearing URL; review finding #1).
  const matches = allRecords(store)
    .filter((r) => r.status === "success" && r.result_path && r.url_key === target)
    .sort(byNewestFirst);
  return matches[0]?.result_path ?? null;
}

/** Most-recent capture attempts, newest-first, capped at `limit`. */
export function listRecent(store: SettingsLike, limit: number): IngestLogRecord[] {
  return allRecords(store).sort(byNewestFirst).slice(0, Math.max(0, limit));
}

/** Every failed attempt, newest-first — the dashboard's "needs attention" list (D7). */
export function listFailures(store: SettingsLike): IngestLogRecord[] {
  return allRecords(store)
    .filter((r) => r.status === "failed")
    .sort(byNewestFirst);
}
