// Real embedding model via node-llama-cpp (plan 036 Phase 3 / spec 035 §F2).
// CPU inference over a GGUF model — the production drop-in for the bundled
// deterministic hash embedder, behind the same `Embedder` interface.
//
// Default model: EmbeddingGemma-300M (Q8_0 GGUF), 768-dim, multilingual. It
// uses ASYMMETRIC prompts — a document prompt for indexed passages and a query
// prompt for searches — so this exposes both `embed` (document) and
// `embedQuery` (query). node-llama-cpp + the model are loaded lazily on the
// first embed, so importing this module costs nothing until it's used (tests
// and CI keep using the hash embedder and never load the native binary).
//
// node-llama-cpp ships CPU prebuilt binaries; the GPU (CUDA/Vulkan) variants
// are stripped at install by `.pnpmfile.cjs` to keep the footprint ~60 MB.

import type { Embedder } from "./hybrid-index.js";

export interface LlamaEmbedderOptions {
  /**
   * Absolute path to the GGUF model file, or a (lazy, possibly async) resolver
   * that produces it on first embed — e.g. a downloader/cache. Resolving lazily
   * keeps construction free of I/O and network until the model is actually used.
   */
  modelPath: string | (() => string | Promise<string>);
  /** Prompt wrapper for indexed documents (default: EmbeddingGemma's). */
  documentPrompt?: (text: string) => string;
  /** Prompt wrapper for search queries (default: EmbeddingGemma's). */
  queryPrompt?: (text: string) => string;
}

// EmbeddingGemma's documented retrieval prompts.
const defaultDocumentPrompt = (text: string): string => `title: none | text: ${text}`;
const defaultQueryPrompt = (text: string): string => `task: search result | query: ${text}`;

type EmbeddingContext = { getEmbeddingFor(text: string): Promise<{ vector: readonly number[] }> };

export function createLlamaEmbedder(options: LlamaEmbedderOptions): Embedder {
  const documentPrompt = options.documentPrompt ?? defaultDocumentPrompt;
  const queryPrompt = options.queryPrompt ?? defaultQueryPrompt;

  // Lazily load node-llama-cpp + the model once, then reuse the context.
  let contextPromise: Promise<EmbeddingContext> | null = null;
  async function loadContext(): Promise<EmbeddingContext> {
    const { getLlama, LlamaLogLevel } = await import("node-llama-cpp");
    const llama = await getLlama({ logLevel: LlamaLogLevel.warn }); // quiet model-load spam
    const modelPath =
      typeof options.modelPath === "function" ? await options.modelPath() : options.modelPath;
    const model = await llama.loadModel({ modelPath });
    return model.createEmbeddingContext();
  }
  const context = (): Promise<EmbeddingContext> =>
    (contextPromise ??= loadContext().catch((error: unknown) => {
      contextPromise = null; // a failed load (bad path, OOM) must not poison the embedder forever
      throw error;
    }));

  // Serialize embeds to bound CPU/RAM (one inference at a time); callers — index
  // build and recall — embed sequentially anyway, so this never adds latency.
  let queue: Promise<unknown> = Promise.resolve();
  const embedWith = (text: string, wrap: (t: string) => string): Promise<number[]> => {
    const run = queue.then(async () => {
      const ctx = await context();
      const { vector } = await ctx.getEmbeddingFor(wrap(text));
      return [...vector];
    });
    queue = run.catch(() => undefined); // keep the chain alive past a failure
    return run;
  };

  return {
    embed: (text) => embedWith(text, documentPrompt),
    embedQuery: (text) => embedWith(text, queryPrompt),
  };
}
