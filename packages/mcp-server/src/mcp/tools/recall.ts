import { DEFAULT_AGENT_ID, type LibrarianStore, formatRecall } from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolContext, ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";

const recall: ToolDefinition = {
  name: "recall",
  description:
    "Search memories by query, tags, and conv-state domain. Domain filtering " +
    "is automatic: results are scoped to the calling conversation's domain " +
    "plus globals. Pass `include_other_domains: true` to broaden a single " +
    "call to all domains. `tags` filters to memories carrying any of the " +
    "supplied tags. Pass `include_ids: true` to prefix each result with its " +
    "memory id for the verify-after-recall loop.",
  inputSchema: {
    type: "object",
    properties: {
      agent_id: { type: "string" },
      query: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      project_key: { type: "string" },
      conv_id: { type: "string", description: "Conversation identifier from the harness hook." },
      include_other_domains: { type: "boolean", default: false },
      include_ids: { type: "boolean" },
      limit: { type: "number" },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const convId = typeof scoped.conv_id === "string" ? scoped.conv_id : "";
    delete scoped.conv_id;
    const domain = resolveCallerDomain(store, convId, context);
    const memories = store.searchMemories({
      ...scoped,
      domain,
      include_other_domains: scoped.include_other_domains === true,
      admin: context.role === "admin",
    });
    store.recordRecall(
      memories,
      (scoped.agent_id as string) || DEFAULT_AGENT_ID,
      (scoped.query as string) || "",
    );
    const includeIds = scoped.include_ids === true;
    return textResult(formatRecall(memories, "Relevant Memories", { includeIds }));
  },
};

// Match the `remember` handler's domain-resolution logic: prefer the
// conv_state row when one exists; otherwise fall through to the §4.10
// single-domain fast path; otherwise null (defensive — see §4.11).
function resolveCallerDomain(
  store: LibrarianStore,
  convId: string,
  context: ToolContext,
): string | null {
  if (context.role === "admin") return null;
  if (convId) {
    const state = store.convState.get(convId);
    if (state) return state.domain;
  }
  const rows = store.db.prepare("SELECT name FROM domains LIMIT 2").all() as Array<{
    name: string;
  }>;
  if (rows.length === 1) return rows[0]?.name ?? null;
  return null;
}

export default recall;
