// resolveEmbedder selection tests (plan 036 Phase 3/7 / spec 035 §F2).
// Selection only — these never load/download a model: the llama embedder is
// lazy, so we assert the SHAPE (asymmetric embedQuery present ⇒ llama; absent ⇒
// hash) without triggering a model load.

import { resolveEmbedder } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let prev: string | undefined;

beforeEach(() => {
  prev = process.env.LIBRARIAN_EMBEDDER;
});

afterEach(() => {
  if (prev === undefined) delete process.env.LIBRARIAN_EMBEDDER;
  else process.env.LIBRARIAN_EMBEDDER = prev;
});

describe("resolveEmbedder", () => {
  it("defaults to the hash embedder under a test run (VITEST set, no override)", () => {
    delete process.env.LIBRARIAN_EMBEDDER;
    const e = resolveEmbedder({ dataDir: "/tmp/does-not-matter" });
    expect(e.embedQuery).toBeUndefined(); // hash is symmetric — no model, no download
  });

  it("LIBRARIAN_EMBEDDER=hash forces the hash embedder", () => {
    process.env.LIBRARIAN_EMBEDDER = "hash";
    expect(resolveEmbedder({ dataDir: "/tmp/x" }).embedQuery).toBeUndefined();
  });

  it("LIBRARIAN_EMBEDDER=llama selects the asymmetric model embedder (lazily, not loaded)", () => {
    process.env.LIBRARIAN_EMBEDDER = "llama";
    const e = resolveEmbedder({ dataDir: "/tmp/x" });
    // llama exposes embedQuery (asymmetric prompts); the model is NOT loaded here
    expect(typeof e.embedQuery).toBe("function");
  });
});
