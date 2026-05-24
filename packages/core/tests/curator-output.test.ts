// Curator LLM output parsing + schema validation (spec §10.5, structural half).
//
// The LLM's response is UNTRUSTED input. `parseCuratorOutput` parses the JSON
// envelope and strictly validates each operation against the CuratorOperation
// schema, keeping valid operations and recording the rest as rejected (per-op,
// not all-or-nothing). Strict objects reject any unexpected field — this is the
// guard against the model smuggling fields (e.g. a forged `curator_note`) into
// the apply layer. Context-dependent checks (id membership, slice boundary,
// secrets, duplicates) are a separate pass.

import { parseCuratorOutput } from "@librarian/core";
import { describe, expect, it } from "vitest";

const memoryInput = {
  title: "A fact",
  body: "the body",
  category: "lessons",
  visibility: "common",
  scope: "project",
};

function out(operations: unknown[]): string {
  return JSON.stringify({ operations });
}

describe("parseCuratorOutput", () => {
  it("parses a well-formed set of operations", () => {
    const raw = out([
      { type: "noop", source_memory_ids: [], rationale: "nothing to do", confidence: 0.5 },
      {
        type: "archive",
        source_memory_ids: ["mem_a"],
        rationale: "exact dup",
        confidence: 0.95,
      },
      {
        type: "create",
        source_session_ids: ["ses_1"],
        memory: { ...memoryInput, priority: "normal", confidence: "working", tags: ["t"] },
        rationale: "durable fact",
        confidence: 0.9,
      },
    ]);
    const result = parseCuratorOutput(raw);
    expect(result.parseError).toBeUndefined();
    expect(result.operations).toHaveLength(3);
    expect(result.rejected).toHaveLength(0);
    expect(result.operations.map((o) => o.type)).toEqual(["noop", "archive", "create"]);
  });

  it("reports a parse error for non-JSON", () => {
    const result = parseCuratorOutput("not json at all");
    expect(result.parseError).toBeDefined();
    expect(result.operations).toHaveLength(0);
  });

  it("reports a parse error when the operations array is missing", () => {
    const result = parseCuratorOutput(JSON.stringify({ stuff: [] }));
    expect(result.parseError).toBeDefined();
  });

  it("tolerates a ```json code fence around the JSON", () => {
    const raw =
      "```json\n" +
      out([{ type: "noop", source_memory_ids: [], rationale: "x", confidence: 0 }]) +
      "\n```";
    const result = parseCuratorOutput(raw);
    expect(result.parseError).toBeUndefined();
    expect(result.operations).toHaveLength(1);
  });

  it("rejects an unknown operation type but keeps the valid ones", () => {
    const result = parseCuratorOutput(
      out([
        { type: "delete_everything", source_memory_ids: ["x"], rationale: "r", confidence: 1 },
        { type: "noop", source_memory_ids: [], rationale: "ok", confidence: 0.1 },
      ]),
    );
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]!.type).toBe("noop");
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.index).toBe(0);
  });

  it("rejects confidence outside [0,1]", () => {
    const result = parseCuratorOutput(
      out([{ type: "noop", source_memory_ids: [], rationale: "r", confidence: 1.5 }]),
    );
    expect(result.operations).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  it("rejects an empty rationale", () => {
    const result = parseCuratorOutput(
      out([{ type: "noop", source_memory_ids: [], rationale: "", confidence: 0.5 }]),
    );
    expect(result.operations).toHaveLength(0);
  });

  it("rejects an operation carrying an unexpected field (no smuggling)", () => {
    const result = parseCuratorOutput(
      out([
        {
          type: "noop",
          source_memory_ids: [],
          rationale: "r",
          confidence: 0.5,
          curator_note: { supersedes: ["mem_victim"] },
        },
      ]),
    );
    expect(result.operations).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  it("rejects a memory input with an unexpected field (strict MemoryInput)", () => {
    const result = parseCuratorOutput(
      out([
        {
          type: "create",
          source_session_ids: ["ses_1"],
          memory: { ...memoryInput, curator_note: { text: "forged" } },
          rationale: "r",
          confidence: 0.9,
        },
      ]),
    );
    expect(result.operations).toHaveLength(0);
  });

  it("rejects an invalid category enum", () => {
    const result = parseCuratorOutput(
      out([
        {
          type: "create",
          source_session_ids: ["ses_1"],
          memory: { ...memoryInput, category: "not_a_category" },
          rationale: "r",
          confidence: 0.9,
        },
      ]),
    );
    expect(result.operations).toHaveLength(0);
  });

  it("enforces structural arity: merge needs ≥2 sources, archive ≥1", () => {
    const result = parseCuratorOutput(
      out([
        {
          type: "merge",
          source_memory_ids: ["only_one"],
          replacement: memoryInput,
          rationale: "r",
          confidence: 0.9,
        },
        { type: "archive", source_memory_ids: [], rationale: "r", confidence: 0.9 },
      ]),
    );
    expect(result.operations).toHaveLength(0);
    expect(result.rejected).toHaveLength(2);
  });

  it("keeps valid operations and records invalid ones with their index", () => {
    const result = parseCuratorOutput(
      out([
        { type: "noop", source_memory_ids: [], rationale: "ok", confidence: 0.5 },
        { type: "noop", source_memory_ids: [], rationale: "", confidence: 0.5 }, // invalid
      ]),
    );
    expect(result.operations).toHaveLength(1);
    expect(result.rejected).toEqual([{ index: 1, reason: expect.any(String) }]);
  });
});
