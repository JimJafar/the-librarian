// Intake — the per-item orchestrator (spec 035 §F5). Composes the inbox
// queue + the pipeline into one callable: claim → parse → navigate → judge →
// apply → complete. The scheduler (boot-scan + 5-min tick + chokidar) drives
// this over the inbox; it's a separate increment.
//
// Everything it needs is injected (vault, recall, listActive, llmClient, store),
// so it's testable end-to-end with a temp vault + fakes — no network, no real
// index. A claim lost to another worker, or an unusable model response, returns
// a value-free status rather than throwing.

import type { LlmClient } from "../grooming-llm-client.js";
import { claimInboxItem, completeInboxItem, parseInboxItem } from "../store/corpus/inbox.js";
import type { Vault } from "../store/corpus/vault.js";
import type { Memory } from "../store/memory-store.js";
import {
  type ApplyIntakeDeps,
  type IntakeOutcome,
  type IntakeApplyStore,
  applyIntakePlan,
} from "./apply.js";
import { type IntakeLogger, type LogErrorSink, recordIntakeDecision } from "./decision-log.js";
import { judgeSubmission } from "./judge-step.js";
import type { IntakeThresholds } from "./judge.js";
import { navigateInbox } from "./navigate.js";

export interface IntakeInboxItemDeps {
  vault: Vault;
  /** Index-backed recall over active memories (store.recall, narrowed). */
  recall: (query: string, limit: number) => Promise<Memory[]>;
  /** The active corpus, in listing order (store.listAll({status:"active"})). */
  listActive: () => Memory[];
  llmClient: LlmClient;
  store: IntakeApplyStore;
  /** Actor id that owns intake writes (e.g. "system-consolidator"). */
  actorId: string;
  thresholds?: IntakeThresholds;
  /**
   * Optional operator steering for the judge prompt (spec 044 D-2). Read ONCE per
   * sweep from the committed intake addendum file (`readJobAddendum(store,"intake")`)
   * and threaded down via deps — never re-read per item (intake is the hot path).
   * Redacted + framed as advisory-only by the judge step; empty/absent → today's
   * behaviour (no OPERATOR GUIDANCE block).
   */
  promptAddendum?: string;
  /**
   * Under-evaluation force-propose (spec 044 D-3). When true, the intake addendum is
   * being evaluated, so no item auto-applies: a would-be auto-apply is routed to a
   * PROPOSAL and a would-be auto-archive is SKIPPED. Read ONCE per sweep + threaded
   * via deps (intake is the hot path); default false → byte-identical to before D3a.
   */
  underEvaluation?: boolean;
  /** The addendum version (git hash) under evaluation; tags produced proposals. */
  addendumVersion?: string | null;
  /** Clock (epoch ms) for the atomic claim; defaults to Date.now via the inbox. */
  now?: () => number;
  /** Optional sink for a swallowed apply error (forwarded to applyIntakePlan). */
  onError?: (error: unknown) => void;
  /**
   * Optional intake decision-log writer (spec 043 C1) + the open run id to record
   * this item's outcome against. Purely observational — every write is fail-soft
   * (see decision-log.ts), so a throwing logger can never abort intake. The
   * `logError` sink surfaces a swallowed log-write failure for debug only.
   */
  intakeLog?: IntakeLogger;
  intakeRunId?: string;
  logError?: LogErrorSink;
}

export type IntakeResult =
  | { status: "claimed_by_other" }
  | { status: "consolidated"; outcome: IntakeOutcome }
  | { status: "judge_error"; parseError: string };

/**
 * Intake a single pending inbox item. Claims it (once-only); on a lost race
 * returns `claimed_by_other`. On an unusable model response returns `judge_error`
 * and LEAVES the claim in `.processing/` for the boot reaper to retry. Otherwise
 * applies the plan and completes (removes) the item — INCLUDING when apply
 * returns `{kind:"rejected"}`: a rejection is treated as terminal and the item is
 * still removed (it won't be retried). This intentionally trades the rare
 * transient-store-error drop for never looping on a permanent rejection (e.g. a
 * protected target). Distinguishing retryable vs terminal rejections (so the
 * former leaves the claim) is a follow-up that needs apply to tag the outcome.
 */
export async function intakeInboxItem(
  pendingRelPath: string,
  deps: IntakeInboxItemDeps,
): Promise<IntakeResult> {
  const claimed = claimInboxItem(deps.vault, pendingRelPath, deps.now ? { now: deps.now } : {});
  if (!claimed) return { status: "claimed_by_other" };

  const item = parseInboxItem(deps.vault.readText(claimed));

  const evidence = await navigateInbox(item.text, {
    recall: deps.recall,
    listActive: deps.listActive,
  });
  const judged = await judgeSubmission(
    {
      submissionText: item.text,
      evidence,
      ...(deps.promptAddendum ? { promptAddendum: deps.promptAddendum } : {}),
    },
    { llmClient: deps.llmClient, ...(deps.thresholds ? { thresholds: deps.thresholds } : {}) },
  );
  if (!judged.plan) {
    // The model output was unusable — leave the claim for the reaper to retry
    // rather than dropping the submission. (A persistently-failing model loops
    // on the reaper TTL; that's the degenerate case, not the norm.)
    return { status: "judge_error", parseError: judged.parseError ?? "no plan" };
  }

  const applyDeps: ApplyIntakeDeps = {
    store: deps.store,
    submissionText: item.text,
    actorId: deps.actorId,
    submissionHints: item.hints, // carry the submitter's scope/ownership onto new memories
    ...(deps.underEvaluation
      ? { underEvaluation: true, addendumVersion: deps.addendumVersion }
      : {}),
    // A force-proposal directive rides on the submission itself (ADR 0004), distinct
    // from the deps-level underEvaluation: a force-proposal submission always lands as
    // a proposal, deduped/merged but never auto-applied.
    ...(item.hints.forceProposal ? { forceProposal: true } : {}),
    ...(deps.onError ? { onError: deps.onError } : {}),
  };
  const outcome = applyIntakePlan(judged.plan, applyDeps);
  // Observational decision-log row (spec 043 C1) — full-outcome coverage: applied,
  // proposed, skipped AND failed/rejected items are all recorded. Fail-soft: a
  // log-write throw is swallowed inside recordIntakeDecision, so it can
  // never change filing or abort the sweep. `claimed` is this item's source id.
  recordIntakeDecision(
    deps.intakeLog,
    deps.intakeRunId,
    judged.plan,
    outcome,
    claimed,
    deps.logError,
  );
  // Complete on ANY outcome, including `rejected` — see the contract note above:
  // a rejection is terminal (won't be retried), so the item is removed.
  completeInboxItem(deps.vault, claimed);
  return { status: "consolidated", outcome };
}
