import type { AppRouter } from "@librarian/mcp-server";
import type { inferRouterOutputs } from "@trpc/server";

export type RouterOutputs = inferRouterOutputs<AppRouter>;

/** One node of the vault explorer tree (dirs carry children, files mtime). */
export type VaultTreeNode = RouterOutputs["vault"]["tree"][number];

/** A read file: raw + lenient frontmatter + hash + resolved links + backlinks. */
export type VaultFile = RouterOutputs["vault"]["read"];
