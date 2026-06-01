// Vector index tests (plan 036 Phase 3 / spec 035 §F2). Brute-force cosine
// over stored embeddings — pure given the vectors (the text→vector embedder
// is a separate, pluggable async concern). Fine to ~tens of thousands of docs
// per the spec; ANN is post-MVP.

import { buildVectorIndex, cosineSimilarity } from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("cosineSimilarity", () => {
  it("is 1 for identical direction, 0 for orthogonal, -1 for opposite", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("is 0 when either vector is all-zero (no division by zero)", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 1], [0, 0])).toBe(0);
  });
});

describe("buildVectorIndex", () => {
  it("ranks entries by cosine similarity to the query vector", () => {
    const index = buildVectorIndex([
      { id: "near", vector: [1, 0.1, 0] },
      { id: "mid", vector: [0.5, 0.5, 0] },
      { id: "far", vector: [0, 0, 1] },
    ]);
    const hits = index.search([1, 0, 0]);
    expect(hits.map((h) => h.id)).toEqual(["near", "mid", "far"]);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it("respects the limit", () => {
    const index = buildVectorIndex([
      { id: "a", vector: [1, 0] },
      { id: "b", vector: [0.9, 0.1] },
      { id: "c", vector: [0.8, 0.2] },
    ]);
    expect(index.search([1, 0], 2)).toHaveLength(2);
  });

  it("returns [] for an empty index", () => {
    expect(buildVectorIndex([]).search([1, 0])).toEqual([]);
  });

  it("breaks ties by id for stable ordering", () => {
    const index = buildVectorIndex([
      { id: "zeta", vector: [1, 0] },
      { id: "alpha", vector: [1, 0] },
    ]);
    expect(index.search([1, 0]).map((h) => h.id)).toEqual(["alpha", "zeta"]);
  });
});
