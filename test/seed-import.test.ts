// scripts/seed — the us-only seed/migration tool. Pure helpers (folder routing,
// remember-arg derivation) + the import orchestration driven end-to-end against a
// real markdown store with a SCRIPTED consolidator (no network): references copy
// verbatim, memories replay through the real `remember` handler seed-first, the
// consolidator grooms them, and `--wipe` clears the derived vault.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type InternalLibrarianStore, createLibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const lib = await import(path.resolve(__dirname, "..", "scripts", "seed", "lib.mjs"));

// A scripted curator brain: files every submission as a fresh `create`.
const scriptedClient = {
  async complete() {
    return {
      content: JSON.stringify({
        action: "create",
        title: "Filed",
        body: "Body.",
        tags: [],
        rationale: "r",
        confidence: 0.99,
      }),
      model: "scripted",
      usage: null,
    };
  },
};

describe("seed lib — pure helpers", () => {
  it("derives a title from the first heading, else first line, else filename", () => {
    expect(lib.deriveTitle("# Communication Style\n\nbody", "x.md")).toBe("Communication Style");
    expect(lib.deriveTitle("just a line\nmore", "x.md")).toBe("just a line");
    expect(lib.deriveTitle("", "context/role-and-responsibilities.md")).toBe(
      "role-and-responsibilities",
    );
  });

  it("builds remember args from markdown, honouring optional frontmatter", () => {
    const withFm = lib.rememberArgsFromMarkdown(
      "a.md",
      "---\ntags: [identity]\napplies_to: [Jim]\nproject_key: proj-x\n---\n# Anna\nmoved",
      "agent-a",
    );
    expect(withFm).toMatchObject({
      agent_id: "agent-a",
      title: "Anna",
      tags: ["identity"],
      applies_to: ["Jim"],
      project_key: "proj-x",
    });
    const noFm = lib.rememberArgsFromMarkdown("b.md", "# Plain\ntext", "agent-a");
    expect(noFm).toEqual({ agent_id: "agent-a", title: "Plain", body: "# Plain\ntext" });

    // CRLF-authored frontmatter must still parse (Windows / git autocrlf).
    const crlf = lib.rememberArgsFromMarkdown(
      "c.md",
      "---\r\ntags: [a, b]\r\n---\r\n# T\r\nbody",
      "agent-a",
    );
    expect(crlf.tags).toEqual(["a", "b"]);
  });

  it("builds remember args from an extract record, falling back the agent id", () => {
    expect(
      lib.rememberArgsFromExtractRecord({ title: "T", body: "B", tags: ["x"] }, "fallback"),
    ).toEqual({ agent_id: "fallback", title: "T", body: "B", tags: ["x"] });
  });
});

describe("seed lib — runSeedImport (end to end, scripted consolidator)", () => {
  let dataDir = "";
  let sourceDir = "";
  let store: InternalLibrarianStore | null = null;
  let savedFlag: string | undefined;

  beforeEach(() => {
    savedFlag = process.env.LIBRARIAN_CONSOLIDATOR;
    process.env.LIBRARIAN_CONSOLIDATOR = "on"; // remember → inbox
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-seed-data-"));
    sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-seed-src-"));
    fs.mkdirSync(path.join(sourceDir, "memories"), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, "references", "AI"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, "memories", "identity.md"),
      "# Identity\nJim builds agents.",
    );
    fs.writeFileSync(path.join(sourceDir, "references", "AI", "note.md"), "# Background\nlong doc");
    store = createLibrarianStore({ dataDir, backend: "markdown" });
  });
  afterEach(() => {
    try {
      store?.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(sourceDir, { recursive: true, force: true });
    if (savedFlag === undefined) delete process.env.LIBRARIAN_CONSOLIDATOR;
    else process.env.LIBRARIAN_CONSOLIDATOR = savedFlag;
  });

  it("copies references verbatim and grooms memories through the consolidator", async () => {
    const summary = await lib.runSeedImport({
      store,
      vaultRoot: path.join(dataDir, "vault"),
      sourceDir,
      llmClient: scriptedClient,
    });

    expect(summary.referencesCopied).toBe(1);
    expect(summary.remembered).toBe(1);
    // The reference landed verbatim in the vault, subpath preserved.
    expect(fs.existsSync(path.join(dataDir, "vault", "references", "AI", "note.md"))).toBe(true);
    // The memory was submitted + groomed into an active memory by the (scripted) curator.
    expect(store!.listMemories({ status: "active" }).total).toBeGreaterThanOrEqual(1);
  });

  it("--wipe clears the derived vault before re-importing", async () => {
    await lib.runSeedImport({
      store,
      vaultRoot: path.join(dataDir, "vault"),
      sourceDir,
      llmClient: scriptedClient,
    });
    const before = store!.listMemories({ status: "active" }).total;
    expect(before).toBeGreaterThanOrEqual(1);

    const summary = await lib.runSeedImport({
      store,
      vaultRoot: path.join(dataDir, "vault"),
      sourceDir,
      llmClient: scriptedClient,
      wipe: true,
    });
    expect(summary.wiped).toContain("memories");
    // Rebuilt from the source, not doubled.
    expect(store!.listMemories({ status: "active" }).total).toBe(before);
  });
});
