// Intake decision-log store — the run/operation types + the
// `IntakeStore` contract live in `intake-types.ts`; re-exported from
// this path so importers mirror the curation-store layering. The markdown backend
// uses the sidecar `createJsonIntakeStore`.
export type {
  CompleteIntakeRunInput,
  IntakeOperation,
  IntakeRun,
  IntakeStore,
  CreateIntakeRunInput,
  FailIntakeRunInput,
  ListIntakeRunsInput,
  RecordIntakeOperationInput,
} from "./intake-types.js";
