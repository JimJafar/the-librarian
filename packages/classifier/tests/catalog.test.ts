// Catalog covers the six models from spec §4.3 and resolves by id.

import { describe, expect, it } from "vitest";
import { CATALOG, DEFAULT_MODEL_ID, catalogEntry } from "../src/catalog.js";

describe("CATALOG", () => {
  it("includes the six models from spec §4.3", () => {
    const ids = CATALOG.map((c) => c.id);
    expect(ids).toEqual([
      "qwen3.5-0.8b-instruct",
      "lfm2.5-1.2b-instruct",
      "lfm2.5-1.2b-thinking",
      "qwen3.5-2b-instruct",
      "phi-4-mini-instruct",
      "gemma-4-e2b-it",
    ]);
  });

  it("defaults to LFM2.5-1.2B-Instruct", () => {
    expect(DEFAULT_MODEL_ID).toBe("lfm2.5-1.2b-instruct");
    expect(catalogEntry(DEFAULT_MODEL_ID)?.label).toContain("default");
  });

  it("declares Q4_K_M as the recommended quant across the catalog", () => {
    for (const entry of CATALOG) {
      expect(entry.recommendedQuant).toBe("Q4_K_M");
    }
  });

  it("returns null for an unknown id (custom HF identifiers are opaque)", () => {
    expect(catalogEntry("org/custom-model-GGUF")).toBeNull();
  });
});
