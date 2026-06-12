// Handoff store. The types + error classes live in `handoff-types.ts`;
// re-exported from this old path so importers don't change. The concrete
// store is `createMarkdownHandoffStore`.
export { HandoffAlreadyClaimedError, HandoffNotFoundError } from "./handoff-types.js";
export type {
  ClaimedBy,
  HandoffDetail,
  HandoffStore,
  ListHandoffsContext,
  StoreHandoffContext,
} from "./handoff-types.js";
