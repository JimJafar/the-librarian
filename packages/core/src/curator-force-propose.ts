// Under-evaluation force-propose (spec 044 D-3 / decision D-3). When a curator
// job's prompt addendum has been freshly changed it goes "under evaluation": the
// curator must NOT auto-apply decisions made under the unproven addendum. Instead
// it forces every would-be auto-apply to a PROPOSAL (for human review) and tags
// it with the addendum version, so the whole batch can later be accepted or rolled
// back wholesale (the admin tRPC that drives that is D3b).
//
// Two apply paths consume this (intake `applyIntakePlan` + grooming
// `applyOperations`). They have genuinely different op/decision models, so this
// module owns ONLY the small shared ROUTING RULE both share — the transform from
// a normal routing terminal to its under-evaluation equivalent — plus the shared
// "tag the proposal with the eval version" primitive. Each path keeps its own
// op-specific execution.
//
// The rule (decision D-3), applied ONLY while a job is under_evaluation:
//   - an op that WOULD auto-apply (create/merge/update/supersede/augment/split/…)
//     is routed to `propose` instead — exactly the existing propose path;
//   - the ARCHIVE WRINKLE: an op that would auto-ARCHIVE is `skip`ped (recorded as
//     skipped), NOT proposed — archive (and noop) are not proposable;
//   - a `propose` stays `propose`, a `skip`/`noop` stays `skip`.
// When the job is `accepted` (the default), the transform is the IDENTITY — so the
// accepted path is byte-identical to before D3a (the load-bearing regression).

/**
 * The three routing terminals both apply paths reduce to. `apply` = mutate live
 * memory now; `propose` = file a proposal for human review; `skip` = do nothing.
 * Archive is modelled as `apply` with `isArchive: true` so the rule can divert it
 * to `skip` (the archive wrinkle) rather than `propose`.
 */
export type ForcePropose = "apply" | "propose" | "skip";

/**
 * Map a normal routing terminal to its under-evaluation equivalent (decision D-3).
 *
 * @param terminal what the op WOULD do under the proven (accepted) addendum.
 * @param isArchive true when the would-be apply is an auto-archive (the wrinkle).
 *
 * Identity for `propose`/`skip`. An `apply` becomes `propose`, EXCEPT an auto-
 * archive becomes `skip` (archive is not proposable). Call this ONLY when the job
 * is under_evaluation; when accepted, use the original terminal unchanged.
 */
export function underEvaluationRoute(terminal: ForcePropose, isArchive: boolean): ForcePropose {
  if (terminal !== "apply") return terminal; // propose / skip pass through unchanged
  return isArchive ? "skip" : "propose"; // archive → skip; everything else → propose
}

/**
 * Stamp the addendum eval version onto a curator_note record so D3b's Accept /
 * Roll-back / Re-evaluate can find every proposal produced under this addendum
 * version. exactOptionalPropertyTypes-safe: a null/empty version adds NO key (so
 * the tag never appears on an accepted-path proposal). Mutates + returns the note.
 */
export function tagAddendumVersion(
  note: Record<string, unknown>,
  evalVersion: string | null | undefined,
): Record<string, unknown> {
  if (evalVersion) note.addendum_version = evalVersion;
  return note;
}

/**
 * Mark a curator_note record as produced by a grooming DRY-RUN (spec 044 D-4) so
 * the D7 dashboard can distinguish + discard throwaway dry-run proposals. A dry-
 * run runs a CANDIDATE (uncommitted) addendum over the corpus in propose-mode —
 * its proposals must never look like real ones. exactOptionalPropertyTypes-safe:
 * `dry_run` is set only when true; the candidate label only when non-empty. A dry-
 * run proposal is NEVER tagged with an addendum_version (that's committed
 * evaluation). Mutates + returns the note.
 */
export function tagDryRun(
  note: Record<string, unknown>,
  candidateLabel: string | null | undefined,
): Record<string, unknown> {
  note.dry_run = true;
  if (candidateLabel) note.dry_run_candidate = candidateLabel;
  return note;
}

/**
 * Translate a job's addendum evaluation state into the apply-path deps spread that
 * turns force-propose on (spec 044 D-3). Both ticks read the status ONCE per
 * sweep/tick and spread this into the apply caller:
 *
 *  - accepted (the default) → `{}` (no key): byte-identical to before D3a.
 *  - under_evaluation → `{ underEvaluation: true, addendumVersion }`.
 *
 * exactOptionalPropertyTypes-safe (the accepted branch adds nothing).
 */
export function forceProposeDeps(state: {
  status: "accepted" | "under_evaluation";
  evalVersion: string | null;
}): { underEvaluation?: true; addendumVersion?: string | null } {
  return state.status === "under_evaluation"
    ? { underEvaluation: true, addendumVersion: state.evalVersion }
    : {};
}
