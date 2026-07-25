// `the-librarian refs add <file>` — spec 073 T2 (SC 1, 2, 8, 11).
//
// References are a third of the product's promise ("upload a spec once and
// every agent can search it") and until now there was no way to put one in
// except hand-writing a vault file. This is the first door.
//
// The `--move` flag is the one genuinely dangerous part: it deletes the
// operator's file. The ordering is the whole safety of it — the unlink happens
// strictly AFTER the vault commit lands, so a failed write can never lose the
// source (SC 11).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withStore } from "../../../test/helpers.js";
import { runCli } from "../src/runtime.js";

let srcDir: string;

beforeEach(() => {
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-refs-src-"));
});
afterEach(() => {
  fs.rmSync(srcDir, { recursive: true, force: true });
});

/** Write a source file to import, returning its absolute path. */
function sourceFile(name: string, contents: string): string {
  const file = path.join(srcDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, "utf8");
  return file;
}

const vaultFile = (dataDir: string, rel: string) =>
  fs.readFileSync(path.join(dataDir, "vault", rel), "utf8");

const vaultHas = (dataDir: string, rel: string) => fs.existsSync(path.join(dataDir, "vault", rel));

function gitSubjects(dataDir: string): string[] {
  const result = spawnSync("git", ["-C", path.join(dataDir, "vault"), "log", "--format=%s"], {
    encoding: "utf8",
  });
  return result.stdout.split("\n").filter((line) => line.length > 0);
}

describe("refs add <file> (spec 073 SC 1)", () => {
  it("files a local Markdown file under references/ and reports the path", async () => {
    await withStore(async (store, dataDir) => {
      const file = sourceFile("deploy-policy.md", "# Deploy policy\n\nNever on a Friday.\n");

      const result = await runCli(["refs", "add", file], store);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("references/deploy-policy.md");
      expect(vaultHas(dataDir, "references/deploy-policy.md")).toBe(true);
      expect(vaultFile(dataDir, "references/deploy-policy.md")).toContain("Never on a Friday.");
    });
  });

  it("makes exactly one commit for the import", async () => {
    await withStore(async (store, dataDir) => {
      const before = gitSubjects(dataDir).length;
      await runCli(["refs", "add", sourceFile("a.md", "# A\n\nbody\n")], store);
      expect(gitSubjects(dataDir).length).toBe(before + 1);
    });
  });

  it("records how it arrived, so the capture shows up like any other (SC 8)", async () => {
    await withStore(async (store, dataDir) => {
      const file = sourceFile("a.md", "# A\n\nbody\n");
      await runCli(["refs", "add", file], store);

      // Frontmatter SEMANTICS are pinned by the core helper's own tests
      // (import-file.test.ts); here we only prove the command wired them up.
      const doc = vaultFile(dataDir, "references/a.md");
      expect(doc).toContain("via: cli");
      expect(doc).toMatch(/captured_at: /);
      expect(doc).toContain(file);
    });
  });

  it("keeps the file's own frontmatter (SC 2)", async () => {
    await withStore(async (store, dataDir) => {
      const raw = ["---", "title: Mine", "tags:", "  - obsidian", "---", "", "body", ""].join("\n");
      await runCli(["refs", "add", sourceFile("note.md", raw)], store);

      const doc = vaultFile(dataDir, "references/mine.md");
      expect(doc).toContain("title: Mine");
      expect(doc).toContain("obsidian");
    });
  });

  it("leaves the source file alone by default", async () => {
    await withStore(async (store) => {
      const file = sourceFile("a.md", "# A\n\nbody\n");
      await runCli(["refs", "add", file], store);
      expect(fs.existsSync(file)).toBe(true);
    });
  });
});

describe("refs add --move (spec 073 SC 11)", () => {
  it("removes the source only after the reference is filed", async () => {
    await withStore(async (store, dataDir) => {
      const file = sourceFile("a.md", "# A\n\nbody\n");

      const result = await runCli(["refs", "add", "--move", file], store);

      expect(result.exitCode).toBe(0);
      expect(vaultHas(dataDir, "references/a.md")).toBe(true);
      expect(fs.existsSync(file)).toBe(false);
    });
  });

  it("NEVER deletes the source when the write fails", async () => {
    await withStore(async (store, dataDir) => {
      // Occupy the destination so the store's atomic create refuses.
      await runCli(["refs", "add", sourceFile("a.md", "# A\n\nfirst\n")], store);
      expect(vaultHas(dataDir, "references/a.md")).toBe(true);

      const second = sourceFile("second/a.md", "# A\n\nsecond\n");
      const result = await runCli(["refs", "add", "--move", second], store);

      expect(result.exitCode).not.toBe(0);
      expect(fs.existsSync(second)).toBe(true); // the file the operator would have lost
      expect(vaultFile(dataDir, "references/a.md")).toContain("first"); // unchanged
    });
  });
});

describe("refs add — refusals", () => {
  it("reports a missing file without writing anything", async () => {
    await withStore(async (store, dataDir) => {
      const before = gitSubjects(dataDir).length;

      const result = await runCli(["refs", "add", path.join(srcDir, "nope.md")], store);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toMatch(/not found|no such file/i);
      expect(gitSubjects(dataDir).length).toBe(before);
    });
  });

  it("refuses a non-Markdown file with a message that says what it takes", async () => {
    await withStore(async (store) => {
      const result = await runCli(["refs", "add", sourceFile("a.pdf", "%PDF-1.4")], store);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toMatch(/\.md/);
    });
  });

  it("refuses a directory, pointing at the import verb instead", async () => {
    await withStore(async (store) => {
      const result = await runCli(["refs", "add", srcDir], store);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toMatch(/refs import/);
    });
  });

  it("prints the refs usage when no path is given", async () => {
    await withStore(async (store) => {
      const result = await runCli(["refs", "add"], store);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toMatch(/Usage: the-librarian refs/);
    });
  });
});

// The shared flag parser gives `--move` the following argument as its value
// when that argument isn't another flag, so the path can arrive as the flag's
// value rather than a positional. Both orderings must work — flag order is not
// something an operator should have to get right.
describe("refs add --move — flag order does not matter", () => {
  it("accepts the flag before the path", async () => {
    await withStore(async (store, dataDir) => {
      const file = sourceFile("before.md", "# Before\n\nbody\n");
      const result = await runCli(["refs", "add", "--move", file], store);
      expect(result.exitCode).toBe(0);
      expect(vaultHas(dataDir, "references/before.md")).toBe(true);
      expect(fs.existsSync(file)).toBe(false);
    });
  });

  it("accepts the flag after the path", async () => {
    await withStore(async (store, dataDir) => {
      const file = sourceFile("after.md", "# After\n\nbody\n");
      const result = await runCli(["refs", "add", file, "--move"], store);
      expect(result.exitCode).toBe(0);
      expect(vaultHas(dataDir, "references/after.md")).toBe(true);
      expect(fs.existsSync(file)).toBe(false);
    });
  });
});
