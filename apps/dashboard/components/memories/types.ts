import type { AppRouter } from "@librarian/mcp-server";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type MemoryRow = RouterOutputs["memories"]["list"]["memories"][number];
// One enriched proposal row from the review endpoint (spec 2026-06-20 T3/T4):
// the proposed memory plus its self-describing provenance (action/source/
// rationale), the memories it supersedes (targets), and a server-rendered
// old→new diff (non-null only for a single-target replacement).
export type ProposalReviewRow = RouterOutputs["memories"]["proposalsForReview"][number];
// A single search_references hit — the same shape the agent's verb returns
// (vault path id, score, matched section, heading anchor, char range).
export type ReferenceHit = RouterOutputs["vault"]["searchReferences"]["references"][number];

export type MemoryStatus = "active" | "proposed" | "archived";

export const SORT_FIELDS = [
  { value: "updated_at", label: "Last updated" },
  { value: "created_at", label: "Created" },
  { value: "title", label: "Title" },
] as const;
