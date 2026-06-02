// node-llama-cpp embedder tests (plan 036 Phase 3 / spec 035 §F2).
//
// The real-model test is GATED on LIBRARIAN_TEST_GGUF (a path to a GGUF model)
// so CI never downloads/loads a model — it stays on the deterministic hash
// embedder. Run locally with e.g.
//   LIBRARIAN_TEST_GGUF=/path/embeddinggemma-300M-Q8_0.gguf pnpm --filter @librarian/core test:vitest -- llama-embedder

import { createLlamaEmbedder } from "@librarian/core";
import { describe, expect, it } from "vitest";

const GGUF = process.env.LIBRARIAN_TEST_GGUF;

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe.skipIf(!GGUF)("createLlamaEmbedder (gated: requires LIBRARIAN_TEST_GGUF)", () => {
  it("produces fixed-dim embeddings with query/doc asymmetry and semantic separation", async () => {
    const embedder = createLlamaEmbedder({ modelPath: GGUF! });
    const queryCat = await embedder.embedQuery!("where did the cat sit");
    const docCat = await embedder.embed("the cat sat on the warm mat by the fire");
    const docFinance = await embedder.embed("quarterly financial earnings and revenue report");

    expect(docCat.length).toBeGreaterThan(0);
    expect(queryCat.length).toBe(docCat.length); // query + doc share the vector space
    // the relevant document is closer to the query than the unrelated one
    expect(cosine(queryCat, docCat)).toBeGreaterThan(cosine(queryCat, docFinance));
  }, 120_000);
});
