// Inbox queue — the durable submission queue for the consolidator (spec 035
// §F5 inbox / Open-Q #2 RESOLVED). A submission is stored instantly as
// `inbox/<ts>-<id>.md` (fire-and-forget, off the hot path); consolidation
// happens later, async. Processing is once-only via an ATOMIC CLAIM: the item
// is renamed into `inbox/.processing/`, and the rename winner owns the job —
// a second claim of the same item finds nothing to move and returns null. A
// boot reaper (`releaseStaleClaims`) returns claims a crashed worker left
// behind. One item at a time; the serial FIFO run-chain + scheduler wire on top
// in a follow-on increment.
//
// These are pure vault operations with an injected clock, so FIFO ordering and
// claim age are deterministic. Filenames carry zero-padded epoch-ms prefixes:
// the pending name sorts chronologically (FIFO via the vault's sorted listing);
// the claimed name additionally prefixes the CLAIM time so the reaper can age a
// claim from its filename alone — no mtime reliance (rename preserves mtime).

import matter from "gray-matter";
import { makeId } from "../../constants.js";
import type { Vault } from "./vault.js";

const INBOX_DIR = "inbox";
const PROCESSING_DIR = "inbox/.processing";
// Zero-padded width for epoch-ms prefixes: 13 digits today, 14 by ~2286 — 15
// leaves headroom and keeps lexicographic order == chronological order.
const TS_WIDTH = 15;

/** Clock + id injection so FIFO order, claim age, and filenames are deterministic. */
export interface InboxDeps {
  /** Epoch ms. Defaults to `Date.now()`. */
  now?: () => number;
  /** Item id generator. Defaults to `makeId("inbox")`. */
  generateId?: () => string;
}

export interface InboxItemRef {
  /** Vault-relative path of the pending item (`inbox/<ts>-<id>.md`). */
  relPath: string;
  id: string;
}

/** A parsed inbox submission: identity + creation time + the raw text. */
export interface InboxItem {
  id: string;
  created: string;
  text: string;
}

function pad(ms: number): string {
  return String(ms).padStart(TS_WIDTH, "0");
}

function basename(relPath: string): string {
  const file = relPath.slice(relPath.lastIndexOf("/") + 1);
  return file.endsWith(".md") ? file.slice(0, -3) : file;
}

function quote(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

/** Serialize an inbox submission to its on-disk markdown (frontmatter + text). */
export function serializeInboxItem(item: InboxItem): string {
  const head = `---\nid: ${quote(item.id)}\ncreated: ${quote(item.created)}\n---\n`;
  const body = item.text.trim();
  return body ? `${head}\n${body}\n` : head;
}

/** Parse an inbox submission; tolerant of hand edits (coerces a YAML Date back to ISO). */
export function parseInboxItem(raw: string): InboxItem {
  const { data, content } = matter(raw);
  const createdRaw = (data as { created?: unknown }).created;
  const created = createdRaw instanceof Date ? createdRaw.toISOString() : String(createdRaw ?? "");
  return {
    id: String((data as { id?: unknown }).id ?? ""),
    created,
    text: content.trim(),
  };
}

/**
 * Store a submission in the inbox (instant, fire-and-forget) and return its
 * pending path + id. The filename's zero-padded ms prefix gives FIFO order.
 */
export function writeInbox(vault: Vault, text: string, deps: InboxDeps = {}): InboxItemRef {
  const ms = (deps.now ?? Date.now)();
  const id = (deps.generateId ?? (() => makeId("inbox")))();
  const relPath = `${INBOX_DIR}/${pad(ms)}-${id}.md`;
  vault.writeText(relPath, serializeInboxItem({ id, created: new Date(ms).toISOString(), text }));
  return { relPath, id };
}

/** Pending items, FIFO-ordered, excluding anything already claimed (`.processing/`). */
export function listInbox(vault: Vault): string[] {
  const prefix = `${INBOX_DIR}/`;
  return vault.listMarkdown(INBOX_DIR).filter((rel) => {
    if (!rel.startsWith(prefix) || rel.startsWith(`${PROCESSING_DIR}/`)) return false;
    // Direct children of inbox/ only (a pending item, not a nested file).
    return !rel.slice(prefix.length).includes("/");
  });
}

/**
 * Atomically claim a pending item: rename `inbox/<stem>.md` →
 * `inbox/.processing/<claimMs>-<stem>.md`. Returns the claimed path, or null if
 * the item was already claimed / never existed (the move finds nothing) — the
 * rename winner owns the job.
 */
export function claimInboxItem(vault: Vault, relPath: string, deps: InboxDeps = {}): string | null {
  const claimMs = (deps.now ?? Date.now)();
  const target = `${PROCESSING_DIR}/${pad(claimMs)}-${basename(relPath)}.md`;
  try {
    vault.moveFile(relPath, target);
    return target;
  } catch {
    return null; // source gone — already claimed, or never written
  }
}

/**
 * Return claims older than `olderThanMs` to the pending queue (the boot reaper
 * for crashed-worker claims). Claim age comes from the `<claimMs>-` filename
 * prefix; fresh claims are left in place. Returns the restored pending paths.
 */
export function releaseStaleClaims(
  vault: Vault,
  opts: { olderThanMs: number; now: number },
): string[] {
  const restored: string[] = [];
  for (const claimed of vault.listMarkdown(PROCESSING_DIR)) {
    const name = basename(claimed);
    const dash = name.indexOf("-");
    if (dash <= 0) continue; // malformed — not a claim we wrote; leave it
    const claimMs = Number(name.slice(0, dash));
    if (Number.isNaN(claimMs) || opts.now - claimMs < opts.olderThanMs) continue;
    const pendingPath = `${INBOX_DIR}/${name.slice(dash + 1)}.md`;
    vault.moveFile(claimed, pendingPath);
    restored.push(pendingPath);
  }
  return restored;
}

/** Remove a processed claim from `.processing/`. Idempotent (a no-op if gone). */
export function completeInboxItem(vault: Vault, processingRelPath: string): void {
  vault.removeFile(processingRelPath);
}
