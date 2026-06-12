// Persistent embedding cache (rethink T23 / spec §9 D5). A sidecar directory
// (by convention `<data-dir>/embeddings-cache/` — OUTSIDE the vault, so it is
// never git-committed or pushed) that stores per-file chunk embeddings keyed
// by (relative file path, content hash, embedder model id). It exists so a
// process restart never re-embeds unchanged files: the in-memory
// createCachingEmbedder dies with the process, and under the real model
// (EmbeddingGemma on CPU) re-embedding a large references/ tree on first
// search costs minutes.
//
// Layout: `<dir>/<urlencode(modelId)>/<urlencode(relPath)>.json`, one record
// per source file. The model id lives in the path (not just the record) so
// switching embedders (hash ↔ llama) can never serve a wrong-model vector and
// switching back doesn't thrash. Filenames are URL-encoded so the original
// path is recoverable for pruning without reading every record.
//
// Invalidation is per file and all-or-nothing: a record is valid only when its
// content hash AND its ordered chunk-text hashes match what the caller derived
// from the live file — so both a content edit and a chunker-parameter change
// (same content, different chunks) force a clean re-embed. Every disk
// operation is fail-soft: a missing/corrupt/torn record is a cache miss, a
// failed write is a no-op — the cache can be deleted wholesale at any time.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Embedder } from "./hybrid-index.js";

export interface EmbeddingCacheOptions {
  /** Cache root, e.g. `<data-dir>/embeddings-cache` (must be outside the vault). */
  dir: string;
  /** Stable embedder/model identity (see `Embedder.modelId`); part of the key. */
  modelId: string;
}

/** One persisted vector, validated against the sha256 of the chunk text it embeds. */
export interface CachedChunkVector {
  sha: string;
  vector: number[];
}

interface CacheRecord {
  version: 1;
  modelId: string;
  path: string;
  contentHash: string;
  entries: CachedChunkVector[];
}

export interface EmbeddingCache {
  readonly modelId: string;
  /**
   * The file's cached chunk vectors, in chunk order — or null when anything
   * mismatches (content hash, chunk hashes, model, or a corrupt record).
   */
  get(relPath: string, contentHash: string, chunkShas: string[]): number[][] | null;
  /** Persist the file's chunk vectors (overwrites any prior record). */
  put(relPath: string, contentHash: string, entries: CachedChunkVector[]): void;
  /**
   * Opportunistic orphan cleanup: delete records whose path starts with
   * `prefix` but is not in `livePaths` (i.e. the source file was deleted).
   * Prefix-scoped so a references/ sweep can't evict memories/ entries.
   */
  prune(prefix: string, livePaths: Iterable<string>): void;
}

/** sha256 hex of a text — the content/chunk hash the cache keys on. */
export function contentSha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function createEmbeddingCache(options: EmbeddingCacheOptions): EmbeddingCache {
  const { modelId } = options;
  const modelDir = path.join(options.dir, encodeURIComponent(modelId));
  const recordPath = (relPath: string): string =>
    path.join(modelDir, `${encodeURIComponent(relPath)}.json`);

  function readRecord(relPath: string): CacheRecord | null {
    try {
      const raw = fs.readFileSync(recordPath(relPath), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return null;
      const record = parsed as Partial<CacheRecord>;
      if (record.version !== 1 || record.modelId !== modelId || record.path !== relPath) {
        return null;
      }
      if (typeof record.contentHash !== "string" || !Array.isArray(record.entries)) return null;
      return record as CacheRecord;
    } catch {
      return null; // missing, unreadable, or torn — all just a miss
    }
  }

  return {
    modelId,
    get(relPath, contentHash, chunkShas) {
      const record = readRecord(relPath);
      if (!record || record.contentHash !== contentHash) return null;
      if (record.entries.length !== chunkShas.length) return null;
      const vectors: number[][] = [];
      for (let i = 0; i < chunkShas.length; i++) {
        const entry = record.entries[i];
        if (!entry || entry.sha !== chunkShas[i] || !Array.isArray(entry.vector)) return null;
        vectors.push(entry.vector);
      }
      return vectors;
    },
    put(relPath, contentHash, entries) {
      const record: CacheRecord = { version: 1, modelId, path: relPath, contentHash, entries };
      try {
        fs.mkdirSync(modelDir, { recursive: true });
        // Plain write, no tmp+rename: a torn record fails JSON.parse → miss →
        // re-embed. Cheap correctness over write atomicity.
        fs.writeFileSync(recordPath(relPath), JSON.stringify(record), "utf8");
      } catch {
        /* fail-soft: an unwritable cache only costs a future re-embed */
      }
    },
    prune(prefix, livePaths) {
      const live = new Set(livePaths);
      try {
        for (const name of fs.readdirSync(modelDir)) {
          if (!name.endsWith(".json")) continue;
          const relPath = decodeURIComponent(name.slice(0, -".json".length));
          if (!relPath.startsWith(prefix) || live.has(relPath)) continue;
          fs.rmSync(path.join(modelDir, name), { force: true });
        }
      } catch {
        /* fail-soft: a missing/unreadable dir means nothing to prune */
      }
    },
  };
}

/**
 * Resolve a file's chunk vectors through the cache: serve all of them from
 * disk when the file is unchanged, else embed every chunk (sequentially, like
 * the index build does) and persist the fresh record. Returns vectors in
 * chunk order. This is THE call sites' seam — they never touch get/put
 * directly, so hit/miss/persist stay consistent everywhere.
 */
export async function embedChunksWithCache(
  cache: EmbeddingCache,
  embedder: Embedder,
  relPath: string,
  content: string,
  chunkTexts: string[],
): Promise<number[][]> {
  const contentHash = contentSha(content);
  const chunkShas = chunkTexts.map(contentSha);
  const hit = cache.get(relPath, contentHash, chunkShas);
  if (hit) return hit;
  const vectors: number[][] = [];
  for (const text of chunkTexts) vectors.push(await embedder.embed(text));
  cache.put(
    relPath,
    contentHash,
    vectors.map((vector, i) => ({ sha: chunkShas[i] ?? "", vector })),
  );
  return vectors;
}
