// Curated catalog of GGUF models for the local classifier provider.
// The spec's §4.3 table is the source of truth — keep this in sync
// when the spec moves. The catalog is data, not strategy; the
// admin's job is to pick a row and the dashboard's job is to make
// that pick informed.

export interface CatalogEntry {
  /** Stable identifier exposed to admin config (`classifier.local.model`). */
  id: string;
  /** HuggingFace repo id — `<org>/<name>`. */
  hfRepo: string;
  /** Display label for the dashboard. */
  label: string;
  /** Approximate parameter count, human-readable. */
  parameters: string;
  /** Recommended quantisation per spec §4.3. */
  recommendedQuant: "Q4_K_M" | "Q8_0";
  /** Rough RAM footprint at the recommended quant, in GB. */
  ramGb: number;
  /** License slug — Apache-2.0 / MIT / LFM1.0. */
  license: "Apache-2.0" | "MIT" | "LFM1.0";
  /** Short profile sentence (hardware target + caveats). */
  profile: string;
}

export const CATALOG: readonly CatalogEntry[] = Object.freeze([
  {
    id: "qwen3.5-0.8b-instruct",
    hfRepo: "unsloth/Qwen3.5-0.8B-GGUF",
    label: "Qwen 3.5 0.8B Instruct",
    parameters: "0.8B",
    recommendedQuant: "Q4_K_M",
    ramGb: 1,
    license: "Apache-2.0",
    profile:
      "Smallest catalog entry. Raspberry Pi 4 / constrained hardware. Instruct-only — the 0.8B Thinking variant has documented loop behaviours.",
  },
  {
    id: "lfm2.5-1.2b-instruct",
    hfRepo: "LiquidAI/LFM2.5-1.2B-Instruct-GGUF",
    label: "LFM 2.5 1.2B Instruct (default)",
    parameters: "1.2B",
    recommendedQuant: "Q4_K_M",
    ramGb: 1.5,
    license: "LFM1.0",
    profile:
      "Laptop default. Best balance of size, quality, and structured-output reliability for the classifier's task.",
  },
  {
    id: "lfm2.5-1.2b-thinking",
    hfRepo: "LiquidAI/LFM2.5-1.2B-Thinking-GGUF",
    label: "LFM 2.5 1.2B Thinking",
    parameters: "1.2B",
    recommendedQuant: "Q4_K_M",
    ramGb: 1.5,
    license: "LFM1.0",
    profile:
      "Same architecture as the default with chain-of-thought. Worth trying via the dashboard eval if Instruct misclassifies your boundary cases. Expect higher parse-failure rates.",
  },
  {
    id: "qwen3.5-2b-instruct",
    hfRepo: "unsloth/Qwen3.5-2B-GGUF",
    label: "Qwen 3.5 2B Instruct",
    parameters: "2B",
    recommendedQuant: "Q4_K_M",
    ramGb: 2.5,
    license: "Apache-2.0",
    profile:
      "Mid-tier. MoE + Gated Delta Networks architecture, 262K context. Multimodal-capable (not exercised by the classifier).",
  },
  {
    id: "phi-4-mini-instruct",
    hfRepo: "unsloth/Phi-4-mini-instruct-GGUF",
    label: "Phi 4 mini Instruct",
    parameters: "3.8B",
    recommendedQuant: "Q4_K_M",
    ramGb: 3.5,
    license: "MIT",
    profile:
      "Desktop choice for reasoning quality. Strongest published benchmarks at this size class. Dense decoder-only, 128K context, function calling.",
  },
  {
    id: "gemma-4-e2b-it",
    hfRepo: "unsloth/gemma-4-E2B-it-GGUF",
    label: "Gemma 4 E2B Instruct",
    parameters: "2.3B (effective)",
    recommendedQuant: "Q4_K_M",
    ramGb: 3.5,
    license: "Apache-2.0",
    profile: "Desktop. Multimodal (text/image/audio), configurable thinking, 128K context.",
  },
]);

export const DEFAULT_MODEL_ID = "lfm2.5-1.2b-instruct";

/**
 * Look up a catalog entry by id, or `null` if unknown — admins can also
 * supply a custom HuggingFace identifier via the dashboard (spec §4.3),
 * which doesn't pass through the catalog. Callers should treat custom
 * ids as opaque.
 */
export function catalogEntry(id: string): CatalogEntry | null {
  return CATALOG.find((entry) => entry.id === id) ?? null;
}
