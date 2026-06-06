// Consolidation (intake) decision-log store — the run/operation types + the
// `ConsolidationStore` contract live in `consolidation-types.ts`; re-exported from
// this path so importers mirror the curation-store layering. The markdown backend
// uses the sidecar `createJsonConsolidationStore`.
export type {
  CompleteConsolidationRunInput,
  ConsolidationOperation,
  ConsolidationRun,
  ConsolidationStore,
  CreateConsolidationRunInput,
  FailConsolidationRunInput,
  ListConsolidationRunsInput,
  RecordConsolidationOperationInput,
} from "./consolidation-types.js";
