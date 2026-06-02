// Consolidator — the per-item orchestrator (spec 035 §F5). Composes the inbox
// queue + the pipeline into one callable: claim → parse → navigate → judge →
// apply → complete. The scheduler (boot-scan + 5-min tick + chokidar) drives
// this over the inbox; it's a separate increment.
//
// Everything it needs is injected (vault, recall, listActive, llmClient, store),
// so it's testable end-to-end with a temp vault + fakes — no network, no real
// index. A claim lost to another worker, or an unusable model response, returns
// a value-free status rather than throwing.

import type { LlmClient } from "../curator-llm-client.js";
import { claimInboxItem, completeInboxItem, parseInboxItem } from "../store/corpus/inbox.js";
import type { Vault } from "../store/corpus/vault.js";
import type { Memory } from "../store/memory-store.js";
import {
  type ApplyConsolidationDeps,
  type ConsolidationOutcome,
  type ConsolidatorApplyStore,
  applyConsolidationPlan,
} from "./apply.js";
import { judgeSubmission } from "./judge-step.js";
import type { ConsolidationThresholds } from "./judge.js";
import { navigateInbox } from "./navigate.js";

export interface ConsolidateInboxItemDeps {
  vault: Vault;
  /** Index-backed recall over active memories (store.recall, narrowed). */
  recall: (query: string, limit: number) => Promise<Memory[]>;
  /** The active corpus, in listing order (store.listAll({status:"active"})). */
  listActive: () => Memory[];
  llmClient: LlmClient;
  store: ConsolidatorApplyStore;
  /** Actor id that owns consolidator writes (e.g. "system-consolidator"). */
  actorId: string;
  thresholds?: ConsolidationThresholds;
  /** Clock (epoch ms) for the atomic claim; defaults to Date.now via the inbox. */
  now?: () => number;
  /** Optional sink for a swallowed apply error (forwarded to applyConsolidationPlan). */
  onError?: (error: unknown) => void;
}

export type ConsolidateResult =
  | { status: "claimed_by_other" }
  | { status: "consolidated"; outcome: ConsolidationOutcome }
  | { status: "judge_error"; parseError: string };

/**
 * Consolidate a single pending inbox item. Claims it (once-only); on a lost race
 * returns `claimed_by_other`. On an unusable model response returns `judge_error`
 * and LEAVES the claim in `.processing/` for the boot reaper to retry. Otherwise
 * applies the plan and completes (removes) the item.
 */
export async function consolidateInboxItem(
  pendingRelPath: string,
  deps: ConsolidateInboxItemDeps,
): Promise<ConsolidateResult> {
  const claimed = claimInboxItem(deps.vault, pendingRelPath, deps.now ? { now: deps.now } : {});
  if (!claimed) return { status: "claimed_by_other" };

  const item = parseInboxItem(deps.vault.readText(claimed));

  const evidence = await navigateInbox(item.text, {
    recall: deps.recall,
    listActive: deps.listActive,
  });
  const judged = await judgeSubmission(
    { submissionText: item.text, evidence },
    { llmClient: deps.llmClient, ...(deps.thresholds ? { thresholds: deps.thresholds } : {}) },
  );
  if (!judged.plan) {
    // The model output was unusable — leave the claim for the reaper to retry
    // rather than dropping the submission. (A persistently-failing model loops
    // on the reaper TTL; that's the degenerate case, not the norm.)
    return { status: "judge_error", parseError: judged.parseError ?? "no plan" };
  }

  const applyDeps: ApplyConsolidationDeps = {
    store: deps.store,
    submissionText: item.text,
    actorId: deps.actorId,
    ...(deps.onError ? { onError: deps.onError } : {}),
  };
  const outcome = applyConsolidationPlan(judged.plan, applyDeps);
  completeInboxItem(deps.vault, claimed);
  return { status: "consolidated", outcome };
}
