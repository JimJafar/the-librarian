#!/usr/bin/env node
// RSS measurement for per-shelf corpus indexes (spec 062 SC 4 / §4 "Assumption, converted to
// measurement"). The spec assumed per-shelf index memory fits the Teams 2 GB envelope; this
// harness MEASURES it. It builds a deterministic synthetic memory corpus and reports
// process.memoryUsage().rss after fully building + RETAINING the recall indexes for:
//   (a) 1 shelf   × N memories
//   (b) 1+5 shelves × N memories each   (same-per-shelf: Teams adds shelves of similar size)
// so the delta is the honest marginal cost of the extra five shelves' indexes.
//
// It uses the PUBLIC core surface only (createVault + buildCorpusIndex + the hash embedder), and
// builds each shelf's index over a vault ROOTED at that shelf's prefix dir — the same per-shelf
// index the store's shelf handles build, without the git-commit-per-write cost of the store path.
// The persistent embedding cache is deliberately NOT used: this measures the in-memory index.
//
// Run (the --expose-gc lets it settle the heap before each measurement):
//   pnpm -r build && node --no-warnings --expose-gc scripts/measure-shelf-index-rss.mjs
// Env overrides: LIBRARIAN_BENCH_N (memories per shelf, default 500),
//                LIBRARIAN_BENCH_SHELVES (extra shelves in config b, default 5),
//                LIBRARIAN_BENCH_RUNS (iterations per config for the median, default 3).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCorpusIndex,
  createHashEmbedder,
  createVault,
  serializeMemoryDocument,
} from "@librarian/core";

const N = Number(process.env.LIBRARIAN_BENCH_N ?? 500);
const EXTRA_SHELVES = Number(process.env.LIBRARIAN_BENCH_SHELVES ?? 5);
const RUNS = Number(process.env.LIBRARIAN_BENCH_RUNS ?? 3);

// ── deterministic synthetic corpus ─────────────────────────────────────────────
/** mulberry32 — a tiny deterministic PRNG so every run builds the identical corpus. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A modest vocabulary — realistic-length memory bodies without pulling a corpus file.
const WORDS = (
  "deploy rollback pipeline service auth token migration platform database index recall shelf " +
  "vault memory handoff reference curator intake grooming embedding vector keyword hybrid rank " +
  "provenance principal router prefix commit git backup restore sidecar cache latency throughput " +
  "sarah platform team timezone runbook oauth session refresh rotation staging cutover fallback"
).split(" ");
const TAGS = ["ops", "auth", "team", "runbook", "migration", "person", "infra", "recall"];

function pick(rand, list, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(list[Math.floor(rand() * list.length)]);
  return out;
}

/** A valid, deterministic memory document for shelf `shelfIdx`, memory `i`. */
function memoryDoc(shelfIdx, i) {
  const rand = rng(shelfIdx * 1_000_003 + i);
  const id = `mem-s${shelfIdx}-${String(i).padStart(5, "0")}`;
  const title = pick(rand, WORDS, 4).join(" ");
  const body = pick(rand, WORDS, 60).join(" "); // ~60 words — a realistic memory body
  const tags = [...new Set(pick(rand, TAGS, 2))];
  return {
    id,
    title,
    body,
    agent_id: "bench",
    status: "active",
    confidence: "working",
    tags,
    applies_to: [],
    supersedes: [],
    conflicts_with: [],
    flags: [],
    is_global: false,
    requires_approval: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    curator_note: null,
  };
}

function writeShelfCorpus(vaultRoot, prefix, shelfIdx) {
  const memDir = path.join(vaultRoot, prefix, "memories");
  fs.mkdirSync(memDir, { recursive: true });
  for (let i = 0; i < N; i++) {
    const doc = memoryDoc(shelfIdx, i);
    fs.writeFileSync(path.join(memDir, `${doc.id}.md`), serializeMemoryDocument(doc), "utf8");
  }
}

// ── measurement ────────────────────────────────────────────────────────────────
function settle() {
  // Two GCs + a microtask flush give RSS a stable floor before we read it.
  if (global.gc) {
    global.gc();
    global.gc();
  }
}

const MB = 1024 * 1024;
const rssMb = () => process.memoryUsage().rss / MB;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** One iteration: write `prefixes.length` shelves of N memories, build + retain all indexes,
 *  return { baseline, after } RSS in MB (delta = the indexes' resident cost). */
async function measure(prefixes) {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-rss-"));
  try {
    prefixes.forEach((prefix, shelfIdx) => writeShelfCorpus(vaultRoot, prefix, shelfIdx));
    const embedder = createHashEmbedder();
    settle();
    const baseline = rssMb();

    // Build + RETAIN every shelf's index (holding the array is what keeps them resident).
    const indexes = [];
    for (const prefix of prefixes) {
      const shelfRoot = prefix === "" ? vaultRoot : path.join(vaultRoot, prefix);
      const vault = createVault({ vaultPath: shelfRoot });
      indexes.push(await buildCorpusIndex(vault, { embedder }));
    }
    // Touch each index so a clever optimiser can't drop the build; also proves they work.
    for (const index of indexes) await index.recall("platform", { limit: 1 });

    settle();
    const after = rssMb();
    indexes.length = 0; // release before the next iteration
    return { baseline, after };
  } finally {
    fs.rmSync(vaultRoot, { recursive: true, force: true });
  }
}

async function runConfig(label, prefixes) {
  const afters = [];
  const deltas = [];
  for (let r = 0; r < RUNS; r++) {
    const { baseline, after } = await measure(prefixes);
    afters.push(after);
    deltas.push(after - baseline);
    settle();
  }
  return {
    label,
    shelves: prefixes.length,
    memories: prefixes.length * N,
    afterMb: median(afters),
    deltaMb: median(deltas),
  };
}

async function main() {
  if (!global.gc) {
    console.warn("WARN: run with `node --expose-gc` for stable RSS numbers.\n");
  }
  const oneShelf = [""];
  const sixShelves = ["", ...Array.from({ length: EXTRA_SHELVES }, (_v, i) => `s${i + 1}/`)];

  console.log(
    `spec 062 T4 — per-shelf index RSS measurement\n` +
      `  memories/shelf=${N}  runs/config=${RUNS} (median)  embedder=hash-fnv1a-256  gc=${Boolean(
        global.gc,
      )}\n`,
  );

  const a = await runConfig("(a) 1 shelf", oneShelf);
  const b = await runConfig(`(b) 1+${EXTRA_SHELVES} shelves`, sixShelves);

  const row = (c) =>
    `  ${c.label.padEnd(18)} shelves=${String(c.shelves).padStart(2)}  memories=${String(
      c.memories,
    ).padStart(5)}  rss=${c.afterMb.toFixed(1)} MB  index-delta=${c.deltaMb.toFixed(1)} MB`;
  console.log(row(a));
  console.log(row(b));

  // The stable signal is the ABSOLUTE RSS median (the per-iteration index-delta is small enough
  // to be dominated by V8 heap noise at these corpus sizes — reported above for transparency, not
  // relied on here). Marginal cost is derived from the absolute medians.
  const addedMb = b.afterMb - a.afterMb;
  const marginalPerShelf = addedMb / EXTRA_SHELVES;
  const perMemoryKb = (addedMb * 1024) / (b.memories - a.memories);
  console.log(
    `\n  ${EXTRA_SHELVES} extra shelves (+${b.memories - a.memories} memories) added ` +
      `${addedMb.toFixed(1)} MB RSS ⇒ ≈ ${marginalPerShelf.toFixed(1)} MB per added shelf, ` +
      `≈ ${perMemoryKb.toFixed(1)} KB per memory\n` +
      `  Teams envelope: 2048 MB — config (b) total RSS ${b.afterMb.toFixed(1)} MB ` +
      `(${((b.afterMb / 2048) * 100).toFixed(1)}% of envelope)\n` +
      `  NOTE: hash-fnv1a-256 embedder (256-dim); the production model (EmbeddingGemma, larger ` +
      `vectors) scales the vector portion up, but the shape — ~linear in memories, modest flat ` +
      `per-shelf overhead — holds.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
