// Curator prompt addenda as committed vault files (spec 044 D-1 / 2C).
//
// Each curator job (intake / grooming) has a prompt addendum the admin uses to
// teach THIS install's curator its owner's preferences. Pre-044 the addendum was
// a single blind-overwritten setting (`curator.prompt_addendum`, grooming-only,
// no history); 044 moves BOTH jobs' addenda into git-committed vault files
// (`.curator/<job>-addendum.md`). Edits apply immediately (rethink D4) — git
// history is the version trail and the dashboard restore (§8) is the rollback;
// the old under-evaluation lifecycle is gone.
//
// The file read/write/commit + version lives on the store layer (it owns the
// vault + the git committer); these thin helpers expose it behind a focused
// interface and own the one-time migration off the retired setting.

import type { CuratorConsumer } from "./curator-consumers.js";
import type { SettingsStore } from "./store/settings-store.js";

/** A curator job — the same two consumers the LLM config + enablement key over. */
export type CuratorJob = CuratorConsumer;

/** A job's addendum content + its git version (the last-touching commit hash). */
export interface JobAddendum {
  /** The addendum text (empty string when the file is absent — fail-soft). */
  content: string;
  /** The commit hash that last touched the file, or null when it has no history. */
  version: string | null;
}

/**
 * The store slice the addendum helpers need: the committed-file read/write (which
 * the LibrarianStore implements over the vault + git) plus settings for the
 * one-time migration off the legacy setting.
 */
export interface AddendumStore extends SettingsStore {
  readAddendum: (job: CuratorJob) => JobAddendum;
  writeAddendum: (job: CuratorJob, content: string, actorId?: string) => JobAddendum;
}

// The pre-044 grooming addendum setting. Read ONLY by migrateCuratorAddendum to
// seed grooming-addendum.md once; the curator never reads it again (it's retired
// at migration time, exactly like the C2 enablement migration).
export const LEGACY_PROMPT_ADDENDUM_KEY = "curator.prompt_addendum";

// The hard addendum size cap (spec 044 §7.1, ~2 KB), measured in UTF-8 BYTES so a
// multi-byte body counts fully. D1 removed the old `curator.prompt_addendum`
// validation, noting "the cap returns with the D7 editor"; D6b is the write-time
// BACKSTOP: setJobAddendum REFUSES an over-cap addendum (the chat condense loop
// softens it earlier, but the write must never commit an over-cap addendum). The
// byte-for-byte legacy migration (writeAddendum) is deliberately exempt — a pre-044
// addendum can already exceed the cap and must migrate intact.
export const ADDENDUM_MAX_BYTES = 2048;

/**
 * Read a curator job's prompt addendum from its committed vault file (spec 044
 * D-1). Fail-soft: a missing file returns `{ content: "", version: null }` — the
 * fresh-install default, identical to the pre-044 empty-setting behaviour. The
 * version is the file's last-touching commit hash (stable; null until committed).
 */
export function readJobAddendum(store: AddendumStore, job: CuratorJob): JobAddendum {
  return store.readAddendum(job);
}

/**
 * Write a curator job's prompt addendum to its committed vault file AND commit it
 * (spec 044 D-1), so the change is versioned + appears in `git log`. Returns the
 * post-write record (content + the new version hash).
 *
 * Enforces the hard 2 KB cap (spec 044 §7.1 / decision D-10): an addendum over
 * `ADDENDUM_MAX_BYTES` is REFUSED before any write/commit — the backstop the chat
 * condense loop sits in front of. Bytes (not characters) so a multi-byte body is
 * measured fully.
 */
export function setJobAddendum(
  store: AddendumStore,
  job: CuratorJob,
  content: string,
  actorId?: string,
): JobAddendum {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > ADDENDUM_MAX_BYTES) {
    throw new Error(
      `${job} addendum must be ≤ ${ADDENDUM_MAX_BYTES} bytes (~2 KB); got ${bytes} bytes`,
    );
  }
  return store.writeAddendum(job, content, actorId);
}

/**
 * One-time, idempotent, no-clobber migration that moves the legacy grooming
 * addendum setting (`curator.prompt_addendum`) into the committed
 * `.curator/grooming-addendum.md` file so an existing install keeps its EXACT
 * addendum after the 044 upgrade, now git-versioned (spec 044 D-1). Safe to run
 * on every boot/tick — mirrors C2's migrateJobEnablement / C3's debounce seed:
 *
 *  - If `grooming-addendum.md` does NOT yet exist AND the legacy setting IS
 *    present, write the setting's value BYTE-FOR-BYTE into the file + commit it.
 *    No-clobber: an already-present file (e.g. an admin edit after a prior
 *    migration) is left untouched.
 *  - Retire the legacy setting unconditionally once observed, so it can never
 *    re-seed a later edit. A fresh install with no setting leaves the file absent
 *    → readJobAddendum returns "" (today's behaviour).
 *
 * Intake had no legacy addendum source (intake never consumed an addendum
 * pre-044), so this migrates grooming only; intake's file is created on first
 * write (D2 wires intake to read it).
 */
export function migrateCuratorAddendum(store: AddendumStore): void {
  const legacy = store.getSetting(LEGACY_PROMPT_ADDENDUM_KEY);
  if (legacy === null) return; // fresh install (or already migrated) — nothing to do.

  // No-clobber: only seed when there is no destination file at all. Guarding on
  // BOTH content and version (not just version) keeps a hand-placed but not-yet-
  // committed file safe too — never overwrite an addendum the admin already has.
  const existing = store.readAddendum("grooming");
  if (existing.content === "" && existing.version === null) {
    store.writeAddendum("grooming", legacy);
  }
  // Retire the setting regardless — it must never re-seed an edited file later.
  store.deleteSetting(LEGACY_PROMPT_ADDENDUM_KEY);
}
