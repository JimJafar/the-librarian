// Cache-backed reference search (rethink T23 / spec §9 D5, §14.7). The
// success criterion lives here: a second server start does NOT re-embed
// unchanged references (persistent embedding cache, asserted via embedder
// call count across two "boots"). Memory embeddings ride the same cache.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCorpusIndex,
  createEmbeddingCache,
  createHashEmbedder,
  createLibrarianStore,
  createVault,
  searchReferences,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-reference-search-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function writeReference(name: string, body: string): void {
  const dir = path.join(dataDir, "vault", "references");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);
}

/** Hash-embedder-backed counting embedder: real vectors, observable call counts. */
function countingEmbedder() {
  const inner = createHashEmbedder();
  const calls = { embed: 0, embedQuery: 0 };
  return {
    calls,
    embedder: {
      modelId: "hash-fnv1a-256",
      embed: (text: string) => {
        calls.embed += 1;
        return inner.embed(text);
      },
      embedQuery: (text: string) => {
        calls.embedQuery += 1;
        return inner.embed(text);
      },
    },
  };
}

const cacheDir = (): string => path.join(dataDir, "embeddings-cache");

describe("searchReferences (cache-backed)", () => {
  it("success criterion (§14.7): a second boot does not re-embed unchanged references", async () => {
    writeReference("alpha.md", "## Alpha\nfacts about alpha particles");
    writeReference("beta.md", "## Beta\nfacts about beta decay");
    const vault = createVault({ dataDir });

    // boot 1: fresh cache dir → everything embeds once
    const boot1 = countingEmbedder();
    const cache1 = createEmbeddingCache({ dir: cacheDir(), modelId: boot1.embedder.modelId });
    await searchReferences(vault, boot1.embedder, "alpha particles", { cache: cache1 });
    expect(boot1.calls.embed).toBeGreaterThan(0);

    // boot 2: new embedder + new cache instance over the SAME dir (a restart)
    const boot2 = countingEmbedder();
    const cache2 = createEmbeddingCache({ dir: cacheDir(), modelId: boot2.embedder.modelId });
    const hits = await searchReferences(vault, boot2.embedder, "alpha particles", {
      cache: cache2,
    });
    expect(boot2.calls.embed).toBe(0); // documents served from the persistent cache
    expect(boot2.calls.embedQuery).toBe(1); // only the query embeds
    expect(hits[0]?.id).toBe("references/alpha.md");
  });

  it("re-embeds only the file that changed between boots", async () => {
    writeReference("stable.md", "## Stable\nunchanging content");
    writeReference("volatile.md", "## Volatile\noriginal content");
    const vault = createVault({ dataDir });

    const boot1 = countingEmbedder();
    const cache1 = createEmbeddingCache({ dir: cacheDir(), modelId: boot1.embedder.modelId });
    await searchReferences(vault, boot1.embedder, "content", { cache: cache1 });

    writeReference("volatile.md", "## Volatile\nrewritten content entirely");

    const boot2 = countingEmbedder();
    const cache2 = createEmbeddingCache({ dir: cacheDir(), modelId: boot2.embedder.modelId });
    await searchReferences(vault, boot2.embedder, "content", { cache: cache2 });
    expect(boot2.calls.embed).toBe(1); // exactly the rewritten file
  });

  it("opportunistically prunes the cache entry of a deleted reference", async () => {
    writeReference("kept.md", "## Kept\nstays around");
    writeReference("gone.md", "## Gone\nwill be deleted");
    const vault = createVault({ dataDir });
    const { embedder } = countingEmbedder();
    const cache = createEmbeddingCache({ dir: cacheDir(), modelId: embedder.modelId });
    await searchReferences(vault, embedder, "stays", { cache });

    fs.rmSync(path.join(dataDir, "vault", "references", "gone.md"));
    await searchReferences(vault, embedder, "stays", { cache });

    // the orphan's sidecar entry is gone; the live one remains
    const remaining = fs
      .readdirSync(cacheDir(), { recursive: true, encoding: "utf8" })
      .map((p) => decodeURIComponent(path.basename(p)));
    expect(remaining.some((name) => name.includes("gone.md"))).toBe(false);
    expect(remaining.some((name) => name.includes("kept.md"))).toBe(true);
  });

  it("still works without a cache (per-call embed, previous behavior)", async () => {
    writeReference("doc.md", "## Topic\nsome searchable words");
    const { embedder, calls } = countingEmbedder();
    const hits = await searchReferences(createVault({ dataDir }), embedder, "searchable words");
    expect(hits[0]?.id).toBe("references/doc.md");
    expect(calls.embed).toBeGreaterThan(0);
  });

  it("returns [] when there are no references (never loads a model)", async () => {
    fs.mkdirSync(path.join(dataDir, "vault"), { recursive: true });
    const { embedder, calls } = countingEmbedder();
    expect(await searchReferences(createVault({ dataDir }), embedder, "anything")).toEqual([]);
    expect(calls.embed + calls.embedQuery).toBe(0);
  });
});

describe("buildCorpusIndex with the persistent cache (memory embeddings)", () => {
  it("a second corpus-index build across boots re-embeds no unchanged memories", async () => {
    const store = createLibrarianStore({ dataDir });
    try {
      store.createMemory({ agent_id: "codex", title: "Piano", body: "tune twice a year" });
      store.createMemory({ agent_id: "codex", title: "Sailing", body: "boats on open water" });
    } finally {
      store.close();
    }
    const vault = createVault({ dataDir });

    const boot1 = countingEmbedder();
    const cache1 = createEmbeddingCache({ dir: cacheDir(), modelId: boot1.embedder.modelId });
    await buildCorpusIndex(vault, { embedder: boot1.embedder, cache: cache1 });
    expect(boot1.calls.embed).toBe(2);

    const boot2 = countingEmbedder();
    const cache2 = createEmbeddingCache({ dir: cacheDir(), modelId: boot2.embedder.modelId });
    const index = await buildCorpusIndex(vault, { embedder: boot2.embedder, cache: cache2 });
    expect(boot2.calls.embed).toBe(0); // both memories served from disk
    const hits = await index.recall("piano tuning");
    expect(hits.length).toBeGreaterThan(0); // and recall still works off cached vectors
  });
});
