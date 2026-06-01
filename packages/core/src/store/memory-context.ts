// start_context presentation helpers — storage-agnostic, shared by the
// SQLite and markdown backends (plan 036 Phase 2). Dedup-by-id and the
// prose context package the `start_context` verb returns. Extracted from
// memory-store.ts so both backends render identical output.

import type { Memory } from "./memory-store.js";

/** Dedup a memory list by id, preserving first-seen order. */
export function uniqueById(memories: Memory[]): Memory[] {
  const seen = new Set<string>();
  const output: Memory[] = [];
  for (const memory of memories) {
    if (!memory || seen.has(memory.id)) continue;
    seen.add(memory.id);
    output.push(memory);
  }
  return output;
}

/** Render the start_context prose package (Identity / Relationship / notes / relevant). */
export function formatContextPackage({
  identity,
  relationship,
  privateMemories,
  relevant,
}: {
  identity: Memory[];
  relationship: Memory[];
  privateMemories: Memory[];
  relevant: Memory[];
}): string {
  const sections: string[] = [];
  sections.push("Memory Context");
  sections.push("");
  sections.push(formatSection("Identity", identity));
  sections.push(formatSection("Relationship", relationship));
  if (privateMemories.length)
    sections.push(formatSection("Agent Operating Notes", privateMemories));
  if (relevant.length) sections.push(formatSection("Relevant Working Context", relevant));
  return (
    sections.filter(Boolean).join("\n\n").trim() ||
    "Memory Context\n\nNo active memories found yet."
  );
}

function formatSection(title: string, memories: Memory[]): string {
  if (!memories.length) return `${title}\nNo active memories found.`;
  return `${title}\n${memories.map((memory) => `- ${memory.title}: ${memory.body}`).join("\n")}`;
}
