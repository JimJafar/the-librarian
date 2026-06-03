// Backend-selection tests for createLibrarianStore (plan 036 Phase 2 cutover,
// incremental-behind-a-flag). The `markdown` backend routes memory/handoff to
// the git vault and conv-state/settings/curation-runs to sidecar JSON files
// (the residual SQLite db is opened only for the InternalLibrarianStore contract
// + close() until c.1c-ii removes it). SQLite stays the default — no behaviour
// change for existing consumers.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-backend-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const handoffDoc = [
  "## Start & intent",
  "do the thing.",
  "## Journey",
  "x then y.",
  "## Current state",
  "green.",
  "## What's left",
  "ship.",
  "## Open questions",
  "none.",
].join("\n\n");

describe("createLibrarianStore — backend selection", () => {
  it("markdown backend writes memories to the git vault and reads them back", () => {
    const store = createLibrarianStore({ dataDir, backend: "markdown" });
    try {
      const { memory } = store.createMemory({
        agent_id: "codex",
        title: "Use pnpm",
        body: "Always pnpm.",
      });
      // Human-readable filename (title slug + short id), resolvable by id.
      const files = fs.readdirSync(path.join(dataDir, "vault", "memories"));
      expect(files.some((f) => /^use-pnpm-[0-9a-f]{8}\.md$/.test(f))).toBe(true);
      expect(store.getMemory(memory.id)?.title).toBe("Use pnpm");
      expect(store.searchMemories({ query: "pnpm" }).map((m) => m.id)).toContain(memory.id);
    } finally {
      store.close();
    }
  });

  it("markdown backend routes handoffs to the vault and conv-state/settings to sidecar files", () => {
    const store = createLibrarianStore({
      dataDir,
      backend: "markdown",
      secretKey: Buffer.alloc(32, 7),
    });
    try {
      const { handoff_id } = store.handoffs.store(
        { title: "Handoff", document_md: handoffDoc, harness: "claude-code", tags: [] },
        { created_by_agent_id: "agent-a" },
      );
      expect(fs.existsSync(path.join(dataDir, "vault", `handoffs/${handoff_id}.md`))).toBe(true);

      store.convState.upsert("claude:abc", { harness: "claude-code" });
      expect(fs.existsSync(path.join(dataDir, "conv-state.json"))).toBe(true);

      store.setSetting("llm_token", "sk-x", { secret: true });
      expect(store.getSetting("llm_token")).toBe("sk-x");
      expect(fs.existsSync(path.join(dataDir, "settings.json"))).toBe(true);

      // Curator run/operation bookkeeping lands in a sidecar JSON file (c.1c-i),
      // OUTSIDE the git vault — not the residual SQLite db.
      store.createCurationRun({ trigger: "manual", visibility: "common", input_hash: "h1" });
      expect(fs.existsSync(path.join(dataDir, "curation-runs.json"))).toBe(true);
      expect(fs.existsSync(path.join(dataDir, "vault", "curation-runs.json"))).toBe(false);
    } finally {
      store.close();
    }
  });

  it("defaults to the sqlite backend (no vault dir created)", () => {
    const store = createLibrarianStore({ dataDir });
    try {
      store.createMemory({ agent_id: "codex", title: "t", body: "b" });
      expect(fs.existsSync(path.join(dataDir, "librarian.sqlite"))).toBe(true);
      expect(fs.existsSync(path.join(dataDir, "vault"))).toBe(false);
    } finally {
      store.close();
    }
  });

  it("exposes a vault-based skills store on both backends (backend-independent)", () => {
    const skillMd =
      "---\nname: Brewing\ndescription: how to brew tea\n---\n\n## Steps\nboil water\n";
    for (const backend of ["sqlite", "markdown"] as const) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `librarian-skills-${backend}-`));
      const store = createLibrarianStore({ dataDir: dir, backend });
      try {
        expect(store.skills.listSkills()).toEqual([]); // empty before any skill is authored
        fs.mkdirSync(path.join(dir, "vault", "skills", "brewing"), { recursive: true });
        fs.writeFileSync(path.join(dir, "vault", "skills", "brewing", "SKILL.md"), skillMd);
        expect(store.skills.listSkills().map((s) => s.slug)).toEqual(["brewing"]);
        expect(store.skills.getSkill("brewing")?.name).toBe("Brewing");
      } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("markdown recall is index-backed: ranks active memories by query, excludes archived", async () => {
    const store = createLibrarianStore({ dataDir, backend: "markdown" });
    try {
      const piano = store.createMemory({
        agent_id: "codex",
        title: "Piano tuning",
        body: "the grand piano needs tuning twice a year",
      }).memory;
      store.createMemory({
        agent_id: "codex",
        title: "Sailing",
        body: "navigating boats on water",
      });
      const old = store.createMemory({
        agent_id: "codex",
        title: "Old",
        body: "obsolete fact about widgets",
      }).memory;
      store.archiveMemory(old.id);

      const hits = await store.recall({ query: "piano tuning" });
      expect(hits[0]?.id).toBe(piano.id);
      expect(hits.map((m) => m.id)).not.toContain(old.id);
    } finally {
      store.close();
    }
  });

  it("markdown recall with a tag filter returns only matching memories", async () => {
    const store = createLibrarianStore({ dataDir, backend: "markdown" });
    try {
      store.createMemory({
        agent_id: "codex",
        title: "Piano practice",
        body: "scales and arpeggios",
        tags: ["music"],
      });
      store.createMemory({
        agent_id: "codex",
        title: "Piano history",
        body: "the instrument",
        tags: ["trivia"],
      });
      const hits = await store.recall({ query: "piano", tags: ["music"] });
      expect(hits.map((m) => m.title)).toEqual(["Piano practice"]);
    } finally {
      store.close();
    }
  });

  it("markdown recall with no query falls back to keyword searchMemories (filter-only)", async () => {
    const store = createLibrarianStore({ dataDir, backend: "markdown" });
    try {
      store.createMemory({ agent_id: "codex", title: "Tagged", body: "x", tags: ["alpha"] });
      store.createMemory({ agent_id: "codex", title: "Untagged", body: "y" });
      const hits = await store.recall({ tags: ["alpha"] });
      expect(hits.map((m) => m.title)).toEqual(["Tagged"]);
    } finally {
      store.close();
    }
  });

  it("markdown recall never surfaces a proposed memory, even one matching the query", async () => {
    const store = createLibrarianStore({ dataDir, backend: "markdown" });
    try {
      store.createMemory(
        {
          agent_id: "codex",
          title: "Pending piano",
          body: "draft about piano tuning awaiting approval",
          status: "proposed",
        },
        { status: "proposed" },
      );
      const active = store.createMemory({
        agent_id: "codex",
        title: "Active piano",
        body: "piano tuning notes",
      }).memory;
      const hits = await store.recall({ query: "piano tuning" });
      expect(hits.map((m) => m.id)).toEqual([active.id]); // proposed excluded
    } finally {
      store.close();
    }
  });

  it("markdown recall with project_key includes globals + the matching project, excludes others", async () => {
    const store = createLibrarianStore({ dataDir, backend: "markdown" });
    try {
      const global = store.createMemory({
        agent_id: "codex",
        title: "Global piano",
        body: "piano tuning everywhere",
      }).memory; // no project_key → null (global)
      const alpha = store.createMemory({
        agent_id: "codex",
        title: "Alpha piano",
        body: "piano tuning here",
        project_key: "alpha",
      }).memory;
      const beta = store.createMemory({
        agent_id: "codex",
        title: "Beta piano",
        body: "piano tuning elsewhere",
        project_key: "beta",
      }).memory;
      const ids = (await store.recall({ query: "piano tuning", project_key: "alpha" })).map(
        (m) => m.id,
      );
      expect(ids).toContain(global.id); // globals always match (project_key IS NULL)
      expect(ids).toContain(alpha.id); // matching project
      expect(ids).not.toContain(beta.id); // other project excluded
    } finally {
      store.close();
    }
  });

  it("markdown recall reflects a memory written after a prior recall (index cache invalidated on write)", async () => {
    const store = createLibrarianStore({ dataDir, backend: "markdown" });
    try {
      store.createMemory({ agent_id: "codex", title: "First piano", body: "piano tuning one" });
      const first = await store.recall({ query: "piano tuning" });
      expect(first.length).toBe(1);
      // a write AFTER the first recall must invalidate the cached index
      const second = store.createMemory({
        agent_id: "codex",
        title: "Second piano",
        body: "piano tuning two",
      }).memory;
      const after = await store.recall({ query: "piano tuning" });
      expect(after.map((m) => m.id)).toContain(second.id);
    } finally {
      store.close();
    }
  });

  it("markdown recall drops a memory archived after a prior recall (cache invalidated)", async () => {
    const store = createLibrarianStore({ dataDir, backend: "markdown" });
    try {
      const m = store.createMemory({
        agent_id: "codex",
        title: "Ephemeral piano",
        body: "piano tuning soon to be archived",
      }).memory;
      const before = await store.recall({ query: "piano tuning" });
      expect(before.map((x) => x.id)).toContain(m.id);
      store.archiveMemory(m.id); // archive AFTER the recall → must invalidate the cache
      const after = await store.recall({ query: "piano tuning" });
      expect(after.map((x) => x.id)).not.toContain(m.id);
    } finally {
      store.close();
    }
  });

  it("markdown recall bounds results to the limit", async () => {
    const store = createLibrarianStore({ dataDir, backend: "markdown" });
    try {
      for (let i = 0; i < 5; i++) {
        store.createMemory({
          agent_id: "codex",
          title: `Piano ${i}`,
          body: "piano tuning practice drills",
        });
      }
      const hits = await store.recall({ query: "piano tuning", limit: 2 });
      expect(hits.length).toBeLessThanOrEqual(2);
    } finally {
      store.close();
    }
  });
});
