// Curator LLM output parsing + schema validation (spec §10.5, structural half).
//
// The LLM's response is UNTRUSTED input. `parseGroomingOutput` parses the JSON
// envelope and strictly validates each operation against the GroomingOperation
// schema, keeping valid operations and recording the rest as rejected (per-op,
// not all-or-nothing). Strict objects reject any unexpected field — this is the
// guard against the model smuggling fields (e.g. a forged `curator_note`) into
// the apply layer. Context-dependent checks (id membership, slice boundary,
// secrets, duplicates) are a separate pass.

import { parseGroomingOutput } from "@librarian/core";
import { describe, expect, it } from "vitest";

// Rethink T12/S1: `category`/`scope` are gone from the wire contract — the
// strict schema now rejects them like any unexpected field (asserted below).
const memoryInput = {
  title: "A fact",
  body: "the body",
  visibility: "common",
};

function out(operations: unknown[]): string {
  return JSON.stringify({ operations });
}

describe("parseGroomingOutput", () => {
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
        memory: { ...memoryInput, priority: "normal", confidence: "working", tags: ["t"] },
        rationale: "durable fact",
        confidence: 0.9,
      },
    ]);
    const result = parseGroomingOutput(raw);
    expect(result.parseError).toBeUndefined();
    expect(result.operations).toHaveLength(3);
    expect(result.rejected).toHaveLength(0);
    expect(result.operations.map((o) => o.type)).toEqual(["noop", "archive", "create"]);
  });

  it("reports a parse error for non-JSON", () => {
    const result = parseGroomingOutput("not json at all");
    expect(result.parseError).toBeDefined();
    expect(result.operations).toHaveLength(0);
  });

  it("reports a parse error when the operations array is missing", () => {
    const result = parseGroomingOutput(JSON.stringify({ stuff: [] }));
    expect(result.parseError).toBeDefined();
  });

  it("tolerates a ```json code fence around the JSON", () => {
    const raw =
      "```json\n" +
      out([{ type: "noop", source_memory_ids: [], rationale: "x", confidence: 0 }]) +
      "\n```";
    const result = parseGroomingOutput(raw);
    expect(result.parseError).toBeUndefined();
    expect(result.operations).toHaveLength(1);
  });

  it("rejects an unknown operation type but keeps the valid ones", () => {
    const result = parseGroomingOutput(
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
    const result = parseGroomingOutput(
      out([{ type: "noop", source_memory_ids: [], rationale: "r", confidence: 1.5 }]),
    );
    expect(result.operations).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  it("rejects an empty rationale", () => {
    const result = parseGroomingOutput(
      out([{ type: "noop", source_memory_ids: [], rationale: "", confidence: 0.5 }]),
    );
    expect(result.operations).toHaveLength(0);
  });

  it("rejects an operation carrying an unexpected field (no smuggling)", () => {
    const result = parseGroomingOutput(
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
    const result = parseGroomingOutput(
      out([
        {
          type: "create",
          memory: { ...memoryInput, curator_note: { text: "forged" } },
          rationale: "r",
          confidence: 0.9,
        },
      ]),
    );
    expect(result.operations).toHaveLength(0);
  });

  it("rejects a memory input with a non-common visibility (slices are project-key-only, rethink D8)", () => {
    const result = parseGroomingOutput(
      out([
        {
          type: "create",
          memory: { ...memoryInput, visibility: "agent_private" },
          rationale: "r",
          confidence: 0.9,
        },
      ]),
    );
    expect(result.operations).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  it("rejects a create that carries the retired source_session_ids field", () => {
    const result = parseGroomingOutput(
      out([
        {
          type: "create",
          source_session_ids: ["ses_1"],
          memory: memoryInput,
          rationale: "r",
          confidence: 0.9,
        },
      ]),
    );
    expect(result.operations).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  it("rejects an archive that carries the retired source_session_ids field", () => {
    const result = parseGroomingOutput(
      out([
        {
          type: "archive",
          source_memory_ids: ["mem_a"],
          source_session_ids: ["ses_1"],
          rationale: "r",
          confidence: 0.9,
        },
      ]),
    );
    expect(result.operations).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  // Rethink T12/S1 — `category`/`scope` left the wire contract entirely: the
  // store dropped the columns at the cutover, so a model still emitting them
  // (e.g. against a cached pre-v5.2 prompt) is rejected by the strict schema
  // like any other unexpected field.
  it("rejects operations carrying the retired category/scope wire fields", () => {
    const result = parseGroomingOutput(
      out([
        {
          type: "create",
          memory: { ...memoryInput, category: "lessons" },
          rationale: "r",
          confidence: 0.9,
        },
        {
          type: "update",
          source_memory_id: "mem_a",
          patch: { scope: "global" },
          rationale: "r",
          confidence: 0.9,
        },
      ]),
    );
    expect(result.operations).toHaveLength(0);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected[0]!.reason).toMatch(/unexpected field/);
    expect(result.rejected[1]!.reason).toMatch(/unexpected field/);
  });

  it("enforces structural arity: merge needs ≥2 sources, archive ≥1", () => {
    const result = parseGroomingOutput(
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

  it("does not leak model-controlled keys or values into the rejected reason (audit hygiene)", () => {
    const SECRET = "FAKE-SECRET-SHOULD-NOT-APPEAR";
    const result = parseGroomingOutput(
      out([
        // A secret-looking value placed as an unrecognized KEY (model-controlled).
        { type: "noop", source_memory_ids: [], rationale: "r", confidence: 0.5, [SECRET]: 1 },
      ]),
    );
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).not.toContain(SECRET);
  });

  it("keeps valid operations and records invalid ones with their index", () => {
    const result = parseGroomingOutput(
      out([
        { type: "noop", source_memory_ids: [], rationale: "ok", confidence: 0.5 },
        { type: "noop", source_memory_ids: [], rationale: "", confidence: 0.5 }, // invalid
      ]),
    );
    expect(result.operations).toHaveLength(1);
    expect(result.rejected).toEqual([{ index: 1, reason: expect.any(String) }]);
  });
});
