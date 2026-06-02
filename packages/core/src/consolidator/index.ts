// Consolidator — the sole server-side LLM brain (spec 035 §F5), built on the
// kept curator pipeline. Inbox submission → navigate (candidates + ToC map) →
// judge (augment/create/supersede/archive, confidence-banded) → minimal-edit +
// wikilinks. This barrel grows as each step lands; navigate is first.

export {
  type ConsolidationCandidates,
  type ConsolidatorTocEntry,
  type NavigateDeps,
  type NavigateOptions,
  navigateInbox,
} from "./navigate.js";
export {
  type ConsolidationDecision,
  type ConsolidationJudgment,
  type ConsolidationPlan,
  type ConsolidationThresholds,
  type ParsedConsolidationJudgment,
  ConsolidationJudgmentSchema,
  parseConsolidationJudgment,
  routeConsolidation,
} from "./judge.js";
export {
  type BuildConsolidatorPromptInput,
  type JudgeSubmissionDeps,
  type JudgeSubmissionInput,
  type JudgeSubmissionResult,
  CONSOLIDATOR_PROMPT_VERSION,
  buildConsolidatorPrompt,
  judgeSubmission,
} from "./judge-step.js";
export { augmentBody, preservesOriginal } from "./edit.js";
export {
  type ApplyConsolidationDeps,
  type ConsolidationOutcome,
  type ConsolidatorApplyStore,
  type ConsolidatorStoredMemory,
  applyConsolidationPlan,
} from "./apply.js";
export {
  type ConsolidateInboxItemDeps,
  type ConsolidateResult,
  consolidateInboxItem,
} from "./consolidate.js";
export { type ConsolidatorSweepDeps, type SweepSummary, runConsolidatorSweep } from "./sweep.js";
