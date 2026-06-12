// Intake — the sole server-side LLM brain (spec 035 §F5), built on the
// kept curator pipeline. Inbox submission → navigate (candidates + ToC map) →
// judge (augment/create/supersede/archive) → the ONE D13 apply rule →
// minimal-edit + wikilinks.

export {
  type IntakeCandidates,
  type IntakeTocEntry,
  type NavigateDeps,
  type NavigateOptions,
  navigateInbox,
} from "./navigate.js";
export {
  type IntakeJudgment,
  type ParsedIntakeJudgment,
  IntakeJudgmentSchema,
  parseIntakeJudgment,
} from "./judge.js";
export {
  type BuildIntakePromptInput,
  type JudgeSubmissionDeps,
  type JudgeSubmissionInput,
  type JudgeSubmissionResult,
  INTAKE_PROMPT_VERSION,
  buildIntakePrompt,
  judgeSubmission,
} from "./judge-step.js";
export { augmentBody, preservesOriginal } from "./edit.js";
export {
  type ApplyIntakeDeps,
  type IntakeOutcome,
  type IntakeApplyStore,
  type IntakeStoredMemory,
  applyIntakeJudgment,
} from "./apply.js";
export { type IntakeInboxItemDeps, type IntakeResult, intakeInboxItem } from "./intake.js";
export { type IntakeSweepDeps, type SweepSummary, runIntakeSweep } from "./sweep.js";
export { type IntakeLogger, type LogErrorSink } from "./decision-log.js";
