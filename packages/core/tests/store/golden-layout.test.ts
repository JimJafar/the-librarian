// Golden layout test (spec 062 SC 1) — proves the store is INERT by default: a
// representative write/groom cycle, driven under the determinism plumbing
// (`LibrarianStoreOptions.now` / `generateId`, spec 062 §4 "named API addition")
// and the scripted intake LLM client, produces a BYTE-IDENTICAL vault working
// tree ("tree" = everything under `<dataDir>/vault` EXCLUDING `.git`) versus a
// committed fixture. The fixture was captured from the code BEFORE the
// vault-files shelf-relative refactor (T2 step 2); the refactor must leave it
// unchanged (T2 step 4) — that byte-equality IS the "zero behaviour change" proof.
//
// Without the plumbing this comparison flakes on fresh UUIDs-in-filenames and
// wall-clock timestamps — exactly the v1 draft's untestable promise. With it,
// every memory/handoff document is stamped from an injected stepping clock +
// sequential id generator, so the tree is reproducible. The inbox mints its own
// numeric clock/id (a different type, out of this API's scope), so the harness
// keeps it deterministic by fully DRAINING it: the single submission is
// consolidated by the sweep, leaving no transient inbox file in the snapshot.
//
// Regenerate the fixture (only when a DELIBERATE cycle/format change is intended):
//   GOLDEN_UPDATE=1 pnpm --filter @librarian/core exec vitest run tests/store/golden-layout.test.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LibrarianStore, type LlmClient, createLibrarianStore } from "@librarian/core";
import { afterEach, describe, expect, it } from "vitest";

const FIXTURE_URL = new URL("./fixtures/golden-vault-tree.json", import.meta.url);

const dataDirs: string[] = [];
afterEach(() => {
  for (const dir of dataDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ── deterministic injections ──────────────────────────────────────────────────

// A stepping clock: `() => string` (the exact type the markdown stores' `deps.now`
// takes), advancing one fixed minute per call from a fixed epoch. Each createMemory /
// handoff store call reads it exactly once, so distinct writes get distinct — but
// reproducible — ISO timestamps.
function steppingClock(): () => string {
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  let tick = 0;
  return () => new Date(base + tick++ * 60_000).toISOString();
}

// A sequential id generator: `gid-0001`, `gid-0002`, … Short + hyphenated so the
// memory-filename `shortId` (strips `mem_`, drops non-alphanumerics, slices 8)
// yields a distinct, greppable fragment per id, and handoff filenames stay clean.
function sequentialIds(): () => string {
  let n = 0;
  return () => `gid-${String(++n).padStart(4, "0")}`;
}

/** The scripted intake LLM client (spec 062 SC 1 "the groom step runs the scripted LLM
 * client") — the same fake shape the intake/grooming suites use: one canned completion,
 * prompt ignored. */
function scriptedClient(content: string): LlmClient {
  return { complete: async () => ({ content, model: "scripted", usage: null }) };
}

// The judge verdict the scripted client returns for the intake submission: a clean
// `create`, so the item fully consolidates (and drains from the inbox).
const SCRIPTED_JUDGMENT = JSON.stringify({
  action: "create",
  title: "Sarah Chen",
  body: "Sarah Chen now leads the platform team.",
  tags: ["person", "team"],
  rationale: "novel topic",
  confidence: 0.97,
});

const HANDOFF_DOCUMENT = [
  "## Start & intent",
  "Pick up the OAuth migration for the platform service.",
  "",
  "## Journey",
  "Scaffolded the provider config and mapped the legacy token claims.",
  "",
  "## Current state",
  "Auth code path compiles; the refresh-token rotation is stubbed.",
  "",
  "## What's left",
  "Wire rotation, delete the legacy session table, cut over staging.",
  "",
  "## Open questions",
  "Do we keep the legacy cookie for one release as a fallback?",
].join("\n");

const REFERENCE_DOCUMENT = [
  "# OAuth 2.0 (RFC 6749)",
  "",
  "Source: https://www.rfc-editor.org/rfc/rfc6749",
  "",
  "The authorization framework the migration targets.",
  "",
].join("\n");

// ── the representative write/groom cycle ──────────────────────────────────────

/**
 * Build a fresh store under the injected clock + id generator, run the golden cycle
 * (three mixed-kind remembers, a handoff, a reference, and a scripted intake pass),
 * then snapshot the vault working tree (excluding `.git`). The clock/id generators
 * are fresh per build so the sequence is identical across runs.
 */
async function buildGoldenVault(dataDir: string): Promise<Record<string, string>> {
  const store: LibrarianStore = createLibrarianStore({
    dataDir,
    now: steppingClock(),
    generateId: sequentialIds(),
  });
  try {
    // Three remembers of mixed kind: a plain active memory, a global memory, and a
    // protected (requires_approval → proposed) memory — exercising routeMemoryWrite's arms.
    store.createMemory({
      title: "Deploy runbook",
      body: "Blue/green deploys go through the platform pipeline; roll back with `plat rollback`.",
      tags: ["ops", "runbook"],
    });
    store.createMemory(
      { title: "Team timezone", body: "The platform team coordinates on CET.", tags: ["team"] },
      { is_global: true },
    );
    store.createMemory(
      {
        title: "Migrate auth to OAuth",
        body: "Replace the bespoke session tokens with OAuth 2.0 authorization-code flow.",
        tags: ["auth", "migration"],
      },
      { requires_approval: true },
    );

    // A handoff.
    store.handoffs.store(
      {
        title: "OAuth migration handoff",
        document_md: HANDOFF_DOCUMENT,
        project_key: "platform",
        harness: "golden-harness",
        tags: ["auth"],
      },
      { created_by_agent_id: "agent-golden" },
    );

    // A reference (a plain content document — no store-minted clock/id).
    store.vaultFiles.createFile("references/web/oauth-rfc.md", REFERENCE_DOCUMENT);

    // A scripted intake/groom pass: submit one item, then sweep it through
    // navigate→judge→apply with the scripted client. The single item consolidates
    // into a memory (stamped from the injected clock/id) and drains from the inbox.
    store.submitToInbox("Sarah now leads the platform team.");
    const summary = await store.runIntakeSweep({ llmClient: scriptedClient(SCRIPTED_JUDGMENT) });
    // Guard the harness's own assumption: the item must have fully consolidated, or a
    // stranded inbox claim (with its non-injected filename) would flake the snapshot.
    expect(summary).toMatchObject({ consolidated: 1, judgeErrors: 0, errored: 0 });

    return snapshotVaultTree(path.join(dataDir, "vault"));
  } finally {
    store.close();
  }
}

/**
 * Snapshot a vault working tree as `{ posix-relative path → exact file bytes }`, sorted
 * by path, EXCLUDING `.git` (spec 062 SC 1's "tree" definition). Empty directories
 * (a drained `inbox/`) contribute nothing — the snapshot is files only.
 */
function snapshotVaultTree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (absDir: string, relDir: string): void => {
    const entries = fs
      .readdirSync(absDir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name === ".git") continue; // git internals: excluded from the tree
      const abs = path.join(absDir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) files[rel] = fs.readFileSync(abs, "utf8");
    }
  };
  walk(root, "");
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function freshDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-golden-"));
  dataDirs.push(dir);
  return dir;
}

// ── the tests ─────────────────────────────────────────────────────────────────

describe("golden vault layout (spec 062 SC 1)", () => {
  it("the write/groom cycle reproduces the committed fixture byte-for-byte", async () => {
    const actual = await buildGoldenVault(freshDataDir());

    if (process.env.GOLDEN_UPDATE === "1") {
      fs.mkdirSync(path.dirname(FIXTURE_URL.pathname), { recursive: true });
      fs.writeFileSync(FIXTURE_URL, `${JSON.stringify(actual, null, 2)}\n`);
      return;
    }

    const expected = JSON.parse(fs.readFileSync(FIXTURE_URL, "utf8")) as Record<string, string>;
    // Path set first (clearest failure), then per-file bytes, then the whole map.
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const rel of Object.keys(expected)) expect(actual[rel]).toBe(expected[rel]);
    expect(actual).toEqual(expected);
  });

  it("is deterministic across two independent runs (the harness itself has no leak)", async () => {
    const first = await buildGoldenVault(freshDataDir());
    const second = await buildGoldenVault(freshDataDir());
    expect(second).toEqual(first);
  });
});
