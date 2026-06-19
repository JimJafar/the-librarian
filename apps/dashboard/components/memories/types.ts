import type { AppRouter } from "@librarian/mcp-server";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type MemoryRow = RouterOutputs["memories"]["list"]["memories"][number];

export type MemoryStatus = "active" | "proposed" | "archived";

export const SORT_FIELDS = [
  { value: "updated_at", label: "Last updated" },
  { value: "created_at", label: "Created" },
  { value: "title", label: "Title" },
] as const;
