import type { AppRouter } from "@librarian/mcp-server";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type MemoryRow = RouterOutputs["memories"]["list"]["memories"][number];

// Local string-literal unions kept in sync with the Zod enums in
// packages/core/src/schemas/common.ts. The tRPC client's inferred input
// types narrow surprisingly through `inferRouterInputs`, so we mirror
// the schema unions here and cast at the API call site (the server-side
// Zod validator is authoritative).
export type Category =
  | "identity"
  | "relationship"
  | "preferences"
  | "projects"
  | "environment"
  | "tools"
  | "lessons"
  | "people"
  | "open_threads";
export type Visibility = "common" | "agent_private";
export type Scope = "global" | "project" | "environment" | "tool" | "session";
export type MemoryStatus = "active" | "proposed" | "conflicted" | "archived";

export const CATEGORIES: readonly Category[] = [
  "identity",
  "relationship",
  "preferences",
  "projects",
  "environment",
  "tools",
  "lessons",
  "people",
  "open_threads",
];

export const VISIBILITIES: readonly Visibility[] = ["common", "agent_private"];

export const SCOPES: readonly Scope[] = ["global", "project", "environment", "tool", "session"];

export const SORT_FIELDS = [
  { value: "updated_at", label: "Last updated" },
  { value: "created_at", label: "Created" },
  { value: "title", label: "Title" },
  { value: "priority", label: "Priority" },
] as const;
