// Memory <-> markdown-document mapping tests (plan 036 Phase 2, spec 035
// §F1). The markdown backend stores each memory as a markdown file: a
// frontmatter block + the memory body. Phase 2 is parity-first — the
// mapping is lossless for the full current Memory shape (the D16
// frontmatter minimisation happens later, at cutover) — so these pin a
// value-stable and byte-stable round-trip across all field types
// (strings, string arrays, numbers, booleans, null, nested object).

import type { Memory } from "@librarian/core";
import { parseMemoryDocument, serializeMemoryDocument } from "@librarian/core";
import { describe, expect, it } from "vitest";

const NOW = "2026-06-11T00:00:00.000Z";

const memory: Memory = {
  id: "mem_abc",
  agent_id: "codex",
  status: "active",
  tags: ["pnpm", "tooling"],
  applies_to: ["the-librarian"],
  supersedes: [],
  conflicts_with: [],
  flags: [],
  recall_count: 3,
  usefulness_score: 2,
  title: "Use pnpm",
  body: "Always use pnpm, never npm. See [[tooling]].",
  priority: "high",
  confidence: "working",
  project_key: "the-librarian",
  created_at: "2026-06-01T09:00:00.000Z",
  updated_at: "2026-06-01T10:00:00.000Z",
  curator_note: null,
  is_global: false,
  requires_approval: false,
};

describe("memory <-> document mapping", () => {
  it("round-trips by value: parse(serialize(memory)) deep-equals memory", () => {
    expect(parseMemoryDocument(serializeMemoryDocument(memory))).toEqual(memory);
  });

  it("round-trips byte-for-byte: serialize(parse(x)) === x", () => {
    const x = serializeMemoryDocument(memory);
    expect(serializeMemoryDocument(parseMemoryDocument(x))).toBe(x);
  });

  it("preserves the body verbatim (wikilinks untouched)", () => {
    const parsed = parseMemoryDocument(serializeMemoryDocument(memory));
    expect(parsed.body).toBe("Always use pnpm, never npm. See [[tooling]].");
  });

  it("preserves field types: numbers, booleans, null, and arrays", () => {
    const p = parseMemoryDocument(serializeMemoryDocument(memory));
    expect(typeof p.recall_count).toBe("number");
    expect(typeof p.usefulness_score).toBe("number");
    expect(typeof p.is_global).toBe("boolean");
    expect(typeof p.created_at).toBe("string");
    expect(p.project_key).toBe("the-librarian");
    expect(p.conflicts_with).toEqual([]);
  });

  it("preserves a null project_key and a nested curator_note object", () => {
    const m: Memory = {
      ...memory,
      project_key: null,
      curator_note: { source: "curator", run_id: "run_1", confidence: 0.9 },
    };
    const p = parseMemoryDocument(serializeMemoryDocument(m));
    expect(p.project_key).toBeNull();
    expect(p.curator_note).toEqual({ source: "curator", run_id: "run_1", confidence: 0.9 });
  });

  it("round-trips an empty body", () => {
    const p = parseMemoryDocument(serializeMemoryDocument({ ...memory, body: "" }));
    expect(p.body).toBe("");
  });

  it("rejects a document whose frontmatter is missing a required field, naming it", () => {
    const raw = serializeMemoryDocument(memory).replace(/^id:.*\n/m, "");
    expect(() => parseMemoryDocument(raw)).toThrow(/id/);
  });

  it("defaults flags to [] when serialized and round-trips an empty flags list", () => {
    const p = parseMemoryDocument(serializeMemoryDocument(memory));
    expect(p.flags).toEqual([]);
  });

  it("round-trips a populated flags list losslessly", () => {
    const flagged: Memory = {
      ...memory,
      flags: [
        { agent_id: "codex", reason: "superseded by the pnpm policy", created_at: NOW },
        { agent_id: "claude", reason: "no longer accurate", created_at: NOW },
      ],
    };
    const p = parseMemoryDocument(serializeMemoryDocument(flagged));
    expect(p.flags).toEqual(flagged.flags);
  });

  it("parses a legacy document with no flags field as an empty flags list", () => {
    const raw = serializeMemoryDocument(memory).replace(/^flags:.*\n/m, "");
    expect(raw).not.toMatch(/^flags:/m);
    const parsed = parseMemoryDocument(raw);
    expect(parsed.flags).toEqual([]);
  });
});
