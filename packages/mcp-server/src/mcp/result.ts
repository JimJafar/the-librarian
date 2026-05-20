// Shared response helpers for MCP tool handlers.
//
// `textResult` wraps a plain string in the MCP "content" envelope.
// The two conflict formatters are pulled out because both `remember`
// and `promote_session_fact` produce structurally identical "you must
// resolve" prose when the store flags a conflict.

import type { McpTextResult } from "./tool.js";

export function textResult(text: string): McpTextResult {
  return {
    content: [{ type: "text", text }],
  };
}

interface ConflictLike {
  candidate?: unknown;
  conflicts?: unknown;
}

interface TitledBody {
  title: string;
  body: string;
}

function asTitledBody(value: unknown): TitledBody {
  return value as TitledBody;
}

function asTitledBodyList(value: unknown): TitledBody[] {
  return (value as TitledBody[]) || [];
}

export function formatConflict(result: ConflictLike): string {
  const candidate = asTitledBody(result.candidate);
  return [
    "Potential conflicting memories found. Resolve before saving.",
    "",
    `Candidate: ${candidate.title}: ${candidate.body}`,
    "",
    "Conflicts:",
    ...asTitledBodyList(result.conflicts).map((memory) => `- ${memory.title}: ${memory.body}`),
  ].join("\n");
}

export function formatPromotionConflict(result: ConflictLike): string {
  const candidate = asTitledBody(result.candidate);
  return [
    "Promotion blocked by conflicting memories.",
    "",
    `Candidate: ${candidate.title}: ${candidate.body}`,
    "",
    "Conflicts:",
    ...asTitledBodyList(result.conflicts).map((memory) => `- ${memory.title}: ${memory.body}`),
  ].join("\n");
}
