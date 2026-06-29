import { execFileSync } from "node:child_process";

// Seeds the e2e vault with representative, NON-SECRET sample data so every
// documented dashboard route renders real content instead of an empty state
// (docs-site spec T3.1). @librarian/core is ESM-only and the Playwright runner
// is CJS, so the store work runs out-of-process via `node --input-type=module`
// (the same pattern as e2e/fixtures.ts). Idempotency isn't needed: each
// screenshot run starts from a fresh per-run data dir.

function dataDir(): string {
  const dir = process.env.LIBRARIAN_E2E_DATA_DIR;
  if (!dir) {
    throw new Error(
      "LIBRARIAN_E2E_DATA_DIR is unset — playwright.screenshots.config.ts must export it before specs run.",
    );
  }
  return dir;
}

// Kept as a single out-of-process pass (one node spawn) that opens the store
// once and writes every fixture: active memories (Memories / Vault / Analytics /
// Activity), a couple of proposals, a flagged memory, an archived memory, and a
// handoff. All content is invented and carries no tokens, ids, or secrets.
const SEED_SCRIPT = `
import { createLibrarianStore } from "@librarian/core";
const { dataDir } = JSON.parse(process.env.LIBRARIAN_STORE_PAYLOAD);
const store = createLibrarianStore({ dataDir });
try {
  const active = [
    { agent_id: "guybrush", title: "Prefer pnpm over npm in this monorepo", body: "All workspaces are pnpm-managed; npm installs corrupt the lockfile. Run pnpm -w from the repo root.", tags: ["tooling", "monorepo"] },
    { agent_id: "scribe", title: "The curator files memories asynchronously", body: "remember() is fire-and-forget; the curator dedupes, merges, and links on its own schedule — no need to check first.", tags: ["curator"] },
    { agent_id: "guybrush", title: "Merging to main is the release", body: "Every PR bumps the root version and adds a dated CHANGELOG entry; the merge tags and publishes the GitHub release automatically.", tags: ["release", "process"] },
    { agent_id: "bede", title: "Private mode stops all memory writes", body: "When the user goes off the record, stop calling remember, store_handoff, and flag_memory until they toggle back on.", tags: ["privacy"] },
    { agent_id: "scribe", title: "Handoffs carry five required sections", body: "Start & intent, Journey, Current state, What's left, Open questions — the schema rejects a document missing any of them.", tags: ["handoffs"] },
    { agent_id: "guybrush", title: "Reading Room is the product's visual system", body: "Warm-paper and ink palette, a single vermilion rubric accent, flat by default, Fraunces / Newsreader / IBM Plex Mono.", tags: ["design"] },
  ];
  for (const m of active) {
    store.createMemory({ agent_id: m.agent_id, title: m.title, body: m.body, tags: m.tags }, {});
  }

  const flagged = store.createMemory(
    { agent_id: "scribe", title: "Retry policy: 3 attempts, fixed 1s backoff", body: "Network calls retry three times with a flat one-second pause between attempts." },
    {},
  );
  store.flagMemory(flagged.memory.id, "Superseded by the v2 exponential-backoff policy; this advice is now stale.", "guybrush");

  const archived = store.createMemory(
    { agent_id: "scribe", title: "Legacy five-repo coordination rule", body: "The old standalone plugin repos had to be bumped together. Retired — everything lives in this monorepo now." },
    {},
  );
  store.archiveMemory(archived.memory.id, "guybrush");

  const proposals = [
    { title: "Use vitest projects for per-package suites", body: "Each package owns its vitest config; the root runs cross-cutting tests only.", note: { source: "grooming", proposed_action: "create", rationale: "Recurred across three sessions of test work." } },
    { title: "Cloudflare Pages builds the docs from a monorepo subdir", body: "Root install, filtered build, output dir apps/docs/dist, pinned NODE_VERSION.", note: { source: "grooming", proposed_action: "create", rationale: "Surfaced while standing up the docs-as-code site." } },
  ];
  for (const p of proposals) {
    store.createMemory(
      { agent_id: "scribe", title: p.title, body: p.body },
      { requires_approval: true, curator_note: p.note },
    );
  }

  const handoffDoc = [
    "## Start & intent",
    "Stand up the in-repo docs-as-code site so documentation can't drift from the code it describes.",
    "## Journey",
    "Shipped the Astro + Starlight shell and the canonical prose, then the generated reference appendix and its drift-guard.",
    "## Current state",
    "Phases 1 and 2 are merged. The reference regenerates from source and a CI check fails on drift.",
    "## What's left",
    "The screenshot pipeline (this phase) and the thin dashboard / marketing deep-links.",
    "## Open questions",
    "The public docs subdomain hostname is still undecided.",
  ].join("\\n\\n");
  store.handoffs.store(
    {
      title: "Docs-as-code site: screenshot pipeline next",
      document_md: handoffDoc,
      project_key: "the-librarian",
      source_ref: "session_demo",
      cwd: "/home/jim/code/the-librarian",
      harness: "claude-code",
      tags: ["docs-as-code", "phase-3"],
    },
    { created_by_agent_id: "guybrush" },
  );

  process.stdout.write(JSON.stringify({ ok: true }));
} finally {
  store.close();
}
`;

export function seedScreenshotData(): void {
  execFileSync("node", ["--input-type=module", "-e", SEED_SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, LIBRARIAN_STORE_PAYLOAD: JSON.stringify({ dataDir: dataDir() }) },
  });
}
