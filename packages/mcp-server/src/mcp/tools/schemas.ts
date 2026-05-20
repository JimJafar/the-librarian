// Reusable JSON Schema fragments for tool input shapes.
//
// MCP exposes `inputSchema` on each tool via `tools/list`. The wire
// format is JSON Schema (not Zod) — keeping these as plain objects
// avoids serialising Zod at request time. Where a richer Zod schema
// already exists in `@librarian/core/schemas`, prefer to validate
// against that inside the handler.

import { SessionPayloadType } from "@librarian/core/schemas";

const SESSION_PAYLOAD_TYPE_VALUES = Object.values(SessionPayloadType);

export function memoryInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["agent_id", "title", "body", "category"],
    properties: {
      agent_id: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      category: { type: "string" },
      visibility: { type: "string", enum: ["common", "agent_private"] },
      scope: { type: "string" },
      project_key: { type: "string" },
      applies_to: { type: "array", items: { type: "string" } },
      priority: { type: "string" },
      confidence: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
    },
  };
}

export function sessionLifecycleSchema(): {
  type: "object";
  required: string[];
  properties: Record<string, unknown>;
} {
  return {
    type: "object",
    required: ["session_id", "summary"],
    properties: {
      session_id: { type: "string" },
      summary: { type: "string" },
      decisions: { type: "array", items: { type: "string" } },
      files_touched: { type: "array", items: { type: "string" } },
      commands_run: { type: "array", items: { type: "string" } },
      open_questions: { type: "array", items: { type: "string" } },
      next_steps: { type: "array", items: { type: "string" } },
      harness: { type: "string" },
      source_ref: { type: "string" },
    },
  };
}

export { SESSION_PAYLOAD_TYPE_VALUES };
