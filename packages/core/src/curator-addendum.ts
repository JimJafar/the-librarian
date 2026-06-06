// Curator prompt addenda as committed vault files (spec 044 D-1 / 2C).
//
// Each curator job (intake / grooming) has a prompt addendum the admin uses to
// teach THIS install's curator its owner's preferences. Pre-044 the addendum was
// a single blind-overwritten setting (`curator.prompt_addendum`, grooming-only,
// no history); 044 moves BOTH jobs' addenda into git-committed vault files
// (`.curator/<job>-addendum.md`) so 2C's self-improvement loop can diff / revert /
// roll them back by git hash. The version IS the file's last-touching commit hash
// (load-bearing for later PRs: D3 tags proposals with it + rolls back via
// `git checkout <hash>`).
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
 * A curator job's addendum evaluation state (spec 044 D-3 / decision D-3).
 *
 *  - `accepted` (the DEFAULT when unset): the addendum is proven; the curator
 *    auto-applies as normal — byte-identical to pre-D3 behaviour.
 *  - `under_evaluation`: the addendum was freshly changed; the curator force-
 *    proposes every would-be auto-apply (and skips would-be auto-archives) and
 *    tags each proposal with `evalVersion`, so the batch can be accepted or
 *    rolled back wholesale once the admin has reviewed it.
 */
export type AddendumStatus = "accepted" | "under_evaluation";

/** A job's addendum evaluation state + the version being evaluated. */
export interface AddendumStatusRecord {
  /** The evaluation state; defaults to "accepted" when the setting is unset. */
  status: AddendumStatus;
  /**
   * The git hash of the addendum version under evaluation (the file's last-
   * touching commit), or null when accepted / no version was captured.
   */
  evalVersion: string | null;
}

/**
 * The store slice the addendum helpers need: the committed-file read/write (which
 * the LibrarianStore implements over the vault + git) plus settings for the
 * one-time migration off the legacy setting.
 */
export interface AddendumStore extends SettingsStore {
  readAddendum: (job: CuratorJob) => JobAddendum;
  writeAddendum: (job: CuratorJob, content: string) => JobAddendum;
}

// The pre-044 grooming addendum setting. Read ONLY by migrateCuratorAddendum to
// seed grooming-addendum.md once; the curator never reads it again (it's retired
// at migration time, exactly like the C2 enablement migration).
export const LEGACY_PROMPT_ADDENDUM_KEY = "curator.prompt_addendum";

// Per-job addendum evaluation settings (spec 044 D-3), in the unified
// `curator.<job>.*` namespace alongside enablement (`curator.<job>.enabled`) —
// mirrors the C2/C3 key conventions. Both are plain (non-secret) string settings.
const ADDENDUM_STATUS_KEY = (job: CuratorJob): string => `curator.${job}.addendum_status`;
const ADDENDUM_EVAL_VERSION_KEY = (job: CuratorJob): string =>
  `curator.${job}.addendum_eval_version`;

// The only persisted status value other than the default; an unset/unknown value
// reads as "accepted" so existing installs are unchanged (the regression guard).
const UNDER_EVALUATION = "under_evaluation";

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
 */
export function setJobAddendum(
  store: AddendumStore,
  job: CuratorJob,
  content: string,
): JobAddendum {
  return store.writeAddendum(job, content);
}

/**
 * Read a curator job's addendum evaluation state (spec 044 D-3). Unset (the
 * fresh-install default) reads as `{ status: "accepted", evalVersion: null }`, so
 * the curator auto-applies as before D3 — the load-bearing regression default.
 * Any non-"under_evaluation" value also reads as accepted (fail-safe: an unknown
 * value never silently force-proposes). The evalVersion is only meaningful while
 * under_evaluation; it's returned null when accepted.
 */
export function readAddendumStatus(store: AddendumStore, job: CuratorJob): AddendumStatusRecord {
  const raw = store.getSetting(ADDENDUM_STATUS_KEY(job));
  if (raw !== UNDER_EVALUATION) return { status: "accepted", evalVersion: null };
  return {
    status: "under_evaluation",
    evalVersion: store.getSetting(ADDENDUM_EVAL_VERSION_KEY(job)),
  };
}

/**
 * Set a curator job's addendum evaluation state (spec 044 D-3). The two operations
 * D3b's admin tRPC drives:
 *
 *  - "begin evaluation": `setAddendumStatus(store, job, "under_evaluation")` —
 *    captures the CURRENT addendum version (via D1's `readJobAddendum().version`)
 *    as the eval version automatically, unless an explicit `evalVersion` is given.
 *    From now on the job force-proposes (see curator-force-propose.ts) and tags
 *    every proposal with this version.
 *  - "end evaluation": `setAddendumStatus(store, job, "accepted")` — clears the
 *    eval version and resumes auto-apply (Accept / Roll-back land here).
 */
export function setAddendumStatus(
  store: AddendumStore,
  job: CuratorJob,
  status: AddendumStatus,
  evalVersion?: string | null,
): void {
  if (status === "accepted") {
    store.setSetting(ADDENDUM_STATUS_KEY(job), "accepted");
    store.deleteSetting(ADDENDUM_EVAL_VERSION_KEY(job));
    return;
  }
  // Entering evaluation: pin the version being evaluated. An explicit arg wins
  // (D3b's Re-evaluate may pass a specific hash); otherwise capture the current
  // addendum version (D1) — the natural "begin evaluation" primitive.
  const version = evalVersion !== undefined ? evalVersion : store.readAddendum(job).version;
  store.setSetting(ADDENDUM_STATUS_KEY(job), UNDER_EVALUATION);
  if (version) store.setSetting(ADDENDUM_EVAL_VERSION_KEY(job), version);
  else store.deleteSetting(ADDENDUM_EVAL_VERSION_KEY(job));
}

/**
 * One-time, idempotent, no-clobber migration that moves the legacy grooming
 * addendum setting (`curator.prompt_addendum`) into the committed
 * `.curator/grooming-addendum.md` file so an existing install keeps its EXACT
 * addendum after the 044 upgrade, now git-versioned (spec 044 D-1). Safe to run
 * on every boot/tick — mirrors C2's migrateCuratorEnablement / C3's debounce seed:
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
