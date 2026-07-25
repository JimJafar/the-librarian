// `the-librarian refs import <dir>` — spec 073 T4 (SC 5, 6, D5).
//
// The "point it at a folder of existing Markdown" case: an Obsidian vault, a
// docs directory, a pile of specs.
//
// Two decisions are load-bearing and tested here:
//   1. The tree is MIRRORED under references/<source-dirname>/. A real folder
//      repeats filenames (several README.md), so flattening would collide — and
//      a collision is a SKIP, not an overwrite, meaning content would silently
//      never land. Mirroring makes collisions impossible within an import and
//      between separate imports.
//   2. Re-running is safe. Existing destinations are skipped via the store's own
//      atomic-create refusal (no pre-check, so no TOCTOU window) and every skip
//      is REPORTED — silence would read as success.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { withStore } from "../../../test/helpers.js";
import { runCli } from "../src/runtime.js";

let srcRoot: string;

beforeEach(() => {
  srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-refs-import-"));
});
afterEach(() => {
  fs.rmSync(srcRoot, { recursive: true, force: true });
});

/** Build a source tree under `<srcRoot>/<name>` and return its path. */
function tree(name: string, files: Record<string, string>): string {
  const root = path.join(srcRoot, name);
  for (const [rel, contents] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, "utf8");
  }
  return root;
}

const vaultHas = (dataDir: string, rel: string) => fs.existsSync(path.join(dataDir, "vault", rel));

function gitHead(dataDir: string): string {
  return spawnSync("git", ["-C", path.join(dataDir, "vault"), "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
}

describe("refs import <dir> (spec 073 SC 5)", () => {
  it("files every Markdown file, mirroring the tree under the folder name", async () => {
    await withStore(async (store, dataDir) => {
      const root = tree("my-vault", {
        "specs/api.md": "# API\n\nThe API spec.\n",
        "notes/standup.md": "# Standup\n\nNotes.\n",
        "top.md": "# Top\n\nAt the root.\n",
      });

      const result = await runCli(["refs", "import", root], store);

      expect(result.exitCode).toBe(0);
      expect(vaultHas(dataDir, "references/my-vault/specs/api.md")).toBe(true);
      expect(vaultHas(dataDir, "references/my-vault/notes/standup.md")).toBe(true);
      expect(vaultHas(dataDir, "references/my-vault/top.md")).toBe(true);
    });
  });

  it("keeps repeated filenames apart instead of colliding", async () => {
    await withStore(async (store, dataDir) => {
      const root = tree("docs", {
        "specs/README.md": "# Specs\n\nspecs readme\n",
        "notes/README.md": "# Notes\n\nnotes readme\n",
      });

      const result = await runCli(["refs", "import", root], store);

      expect(result.exitCode).toBe(0);
      const specs = fs.readFileSync(
        path.join(dataDir, "vault", "references/docs/specs/README.md"),
        "utf8",
      );
      const notes = fs.readFileSync(
        path.join(dataDir, "vault", "references/docs/notes/README.md"),
        "utf8",
      );
      expect(specs).toContain("specs readme");
      expect(notes).toContain("notes readme");
    });
  });

  it("ignores everything that is not Markdown", async () => {
    await withStore(async (store, dataDir) => {
      const root = tree("mixed", {
        "keep.md": "# Keep\n\nyes\n",
        "skip.txt": "not markdown",
        "image.png": "PNG",
        "nested/doc.pdf": "%PDF-1.4",
      });

      const result = await runCli(["refs", "import", root], store);

      expect(vaultHas(dataDir, "references/mixed/keep.md")).toBe(true);
      expect(vaultHas(dataDir, "references/mixed/skip.txt")).toBe(false);
      expect(vaultHas(dataDir, "references/mixed/image.png")).toBe(false);
      expect(result.stdout).toMatch(/imported 1/i);
    });
  });

  it("reports what it did", async () => {
    await withStore(async (store) => {
      const root = tree("counted", { "a.md": "# A\n\na\n", "b.md": "# B\n\nb\n" });
      const result = await runCli(["refs", "import", root], store);
      expect(result.stdout).toMatch(/imported 2/i);
    });
  });

  it("preserves each file's own frontmatter", async () => {
    await withStore(async (store, dataDir) => {
      const root = tree("obsidian", {
        "note.md": ["---", "title: Kept", "tags:", "  - keepme", "---", "", "body", ""].join("\n"),
      });

      await runCli(["refs", "import", root], store);

      const doc = fs.readFileSync(
        path.join(dataDir, "vault", "references/obsidian/note.md"),
        "utf8",
      );
      expect(doc).toContain("title: Kept");
      expect(doc).toContain("keepme");
      expect(doc).toContain("via: cli");
    });
  });
});

describe("refs import — re-running is safe (spec 073 SC 6)", () => {
  it("skips what is already filed, reports it, and changes nothing", async () => {
    await withStore(async (store, dataDir) => {
      const root = tree("again", { "a.md": "# A\n\na\n", "b.md": "# B\n\nb\n" });

      const first = await runCli(["refs", "import", root], store);
      expect(first.stdout).toMatch(/imported 2/i);
      const headAfterFirst = gitHead(dataDir);

      const second = await runCli(["refs", "import", root], store);

      expect(second.exitCode).toBe(0);
      expect(second.stdout).toMatch(/imported 0/i);
      expect(second.stdout).toMatch(/skipped 2/i);
      // Nothing was written, so the vault's history did not move.
      expect(gitHead(dataDir)).toBe(headAfterFirst);
    });
  });

  it("imports only what is new when the folder has grown", async () => {
    await withStore(async (store, dataDir) => {
      const root = tree("growing", { "a.md": "# A\n\na\n" });
      await runCli(["refs", "import", root], store);

      fs.writeFileSync(path.join(root, "b.md"), "# B\n\nb\n", "utf8");
      const second = await runCli(["refs", "import", root], store);

      expect(second.stdout).toMatch(/imported 1/i);
      expect(second.stdout).toMatch(/skipped 1/i);
      expect(vaultHas(dataDir, "references/growing/b.md")).toBe(true);
    });
  });
});

describe("refs import — refusals", () => {
  it("reports a missing directory", async () => {
    await withStore(async (store) => {
      const result = await runCli(["refs", "import", path.join(srcRoot, "nope")], store);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toMatch(/not found/i);
    });
  });

  it("points a single file at the add verb instead", async () => {
    await withStore(async (store) => {
      const root = tree("single", { "a.md": "# A\n\na\n" });
      const result = await runCli(["refs", "import", path.join(root, "a.md")], store);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toMatch(/refs add/);
    });
  });

  it("says so plainly when a folder holds no Markdown", async () => {
    await withStore(async (store) => {
      const root = tree("empty", { "notes.txt": "nope" });
      const result = await runCli(["refs", "import", root], store);
      expect(result.stdout).toMatch(/no Markdown/i);
    });
  });

  it("prints the refs usage when no directory is given", async () => {
    await withStore(async (store) => {
      const result = await runCli(["refs", "import"], store);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toMatch(/Usage: the-librarian refs/);
    });
  });
});
