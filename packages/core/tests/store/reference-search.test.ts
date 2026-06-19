// Chunked + cached reference search (rethink T23+T24 / spec §9 D5, §14.7).
// The two success criteria live here:
//   1. a second server start does NOT re-embed unchanged references (persistent
//      embedding cache, asserted via embedder call count across two "boots");
//   2. a >100KB reference document is searchable in its TAIL sections (chunked
//      indexing — the old whole-doc embed truncated to ~2K tokens, making
//      everything past that invisible to the vector signal).

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

describe("searchReferences (chunked, cache-backed)", () => {
  it("returns the matching file's best chunk with path id + anchor + bounded excerpt + char range", async () => {
    writeReference(
      "piano-manual.md",
      "# Manual\n\n## Tuning\nthe grand piano needs tuning twice a year\n\n## Cleaning\nwipe the keys",
    );
    const hits = await searchReferences(
      createVault({ dataDir }),
      createHashEmbedder(),
      "piano tuning",
    );
    expect(hits[0]?.id).toBe("references/piano-manual.md"); // wire shape: id is still the vault path
    expect(hits[0]?.section).toContain("tuning twice a year");
    expect(hits[0]?.section).not.toContain("wipe the keys"); // best CHUNK, not the whole doc
    expect(hits[0]?.anchor).toBe("Manual > Tuning");
    expect(typeof hits[0]?.startChar).toBe("number");
    expect(typeof hits[0]?.endChar).toBe("number");
    expect(typeof hits[0]?.score).toBe("number");
  });

  it("ranks the doc that says 'gentle coding' above one that merely spams 'coding'", async () => {
    // The real-world failure the References tab surfaced: 'Coding Is Dead'
    // repeats 'coding' a dozen times but never says 'gentle'; the target says
    // the phrase 'gentle coding'. Under raw summed-tf it tied/won on 'coding'
    // count. BM25 (IDF down-weights the common 'coding') + the exact-phrase
    // signal must rank the real match first. The c*.md docs make 'coding' common.
    writeReference(
      "coding-is-dead.md",
      "# Coding Is Dead\n\ncoding coding coding coding coding coding coding coding coding coding coding coding coding programming",
    );
    writeReference(
      "gentle-codeing.md",
      "# Gentle Codeing\n\ngentle coding is a gentle coding practice; gentle coding stays gentle coding",
    );
    writeReference("c1.md", "coding standards matter");
    writeReference("c2.md", "more coding examples");
    writeReference("c3.md", "coding tips today");

    const hits = await searchReferences(
      createVault({ dataDir }),
      createHashEmbedder(),
      "gentle coding",
    );
    expect(hits[0]?.id).toBe("references/gentle-codeing.md");
  });

  it("collapses multiple matching chunks of one file into a single hit per file", async () => {
    writeReference("doc.md", "## One\nzebra fact alpha\n\n## Two\nzebra fact beta");
    writeReference("other.md", "## Other\nnothing relevant here");
    const hits = await searchReferences(
      createVault({ dataDir }),
      createHashEmbedder(),
      "zebra fact",
    );
    expect(hits.filter((h) => h.id === "references/doc.md")).toHaveLength(1);
  });

  it("success criterion (§14.7): a >100KB document is searchable in its tail sections", async () => {
    // ~120KB of filler sections, then a distinctive fact at the very end —
    // far past the old ~2K-token embedding truncation point.
    const filler = Array.from(
      { length: 30 },
      (_, i) =>
        `## Filler section ${i}\n` +
        `${"lorem ipsum dolor sit amet consectetur adipiscing elit sed do ".repeat(60)}\n`,
    ).join("\n");
    const tail =
      "## Zanzibar quorum\nthe zanzibar quorum protocol requires seventeen lighthouse keepers";
    const doc = `${filler}\n${tail}`;
    expect(doc.length).toBeGreaterThan(100_000);
    writeReference("big.md", doc);

    const hits = await searchReferences(
      createVault({ dataDir }),
      createHashEmbedder(),
      "zanzibar quorum lighthouse keepers",
    );
    expect(hits[0]?.id).toBe("references/big.md");
    expect(hits[0]?.anchor).toContain("Zanzibar quorum");
    expect(hits[0]?.section).toContain("seventeen lighthouse keepers");
    expect(hits[0]?.startChar ?? 0).toBeGreaterThan(100_000); // the TAIL chunk, not the head
    expect(hits[0]!.section.length).toBeLessThan(10_000); // a bounded excerpt, not the whole doc
  });

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
    expect(boot2.calls.embed).toBe(1); // exactly the rewritten file's (single) chunk
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

describe("buildCorpusIndex recall ranking (shared BM25 + phrase signal)", () => {
  it("ranks a both-terms memory above a memory that spams a single common term", async () => {
    // The same fix reaches recall (shared hybrid index): 'coding' is common
    // across memories (low IDF), 'gentle' is rare; the spam memory matches only
    // 'coding'. Under raw summed-tf the spam (coding x6) outranked the real
    // match (gentle x2 + coding x2 = 4). BM25 + phrase must flip it.
    const store = createLibrarianStore({ dataDir });
    let gentleId = "";
    try {
      store.createMemory({
        agent_id: "x",
        title: "Coding spam",
        body: "coding coding coding coding coding coding",
      });
      gentleId = store.createMemory({
        agent_id: "x",
        title: "Gentle coding",
        body: "gentle coding is a gentle coding habit",
      }).memory.id;
      store.createMemory({ agent_id: "x", title: "c1", body: "coding one here" });
      store.createMemory({ agent_id: "x", title: "c2", body: "coding two there" });
    } finally {
      store.close();
    }
    const index = await buildCorpusIndex(createVault({ dataDir }), {
      embedder: createHashEmbedder(),
    });
    const hits = await index.recall("gentle coding");
    expect(hits[0]?.id).toBe(gentleId);
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
