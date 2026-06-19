// Reusable JSON Schema fragments for tool input shapes.
//
// MCP exposes `inputSchema` on each tool via `tools/list`. The wire
// format is JSON Schema (not Zod) — keeping these as plain objects
// avoids serialising Zod at request time. Where a richer Zod schema
// already exists in `@librarian/core/schemas`, prefer to validate
// against that inside the handler.
//
// sessions-rethink PR 7 — `sessionLifecycleSchema` and the
// `SESSION_PAYLOAD_TYPE_VALUES` constant were retired with the rest
// of the session tools.

export function memoryInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["agent_id", "title", "body"],
    properties: {
      agent_id: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      applies_to: { type: "array", items: { type: "string" } },
      priority: { type: "string" },
      confidence: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      // Caller-supplied `is_global` / `requires_approval` are NOT advertised
      // here and are silently ignored by normalizeMemoryInput (spec §4.1–§4.4).
      // `conv_id` was retired with conv_state (rethink T2); `visibility`
      // with the private-namespace split (rethink T3, D8);
      // `category` / `scope` with the storage cutover (rethink T5);
      // `project_key` once memories went project-less (grooming collapsed to a
      // single global slice) — the handler still tolerates all of them from
      // un-updated plugins.
    },
  };
}
