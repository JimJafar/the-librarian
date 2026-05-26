// Integrations contract tests.
//
// All five harnesses (Claude Code, Codex, Hermes, OpenCode, Pi) now ship
// as standalone, installable plugins in their own repos. No in-tree
// harness packages remain in `integrations/`. What this test still
// gates:
//
//   1. `integrations/README.md` links every standalone plugin repo so a
//      newcomer can find them.
//   2. The repo-local `.claude/commands/` per-verb dogfood files are
//      present (and the retired verbs are NOT).
//   3. None of the five graduated harnesses have a directory back
//      inside `integrations/` (regression guard against re-introducing
//      an in-tree copy that would drift from its standalone repo).

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const INTEGRATIONS_DIR = path.join(REPO_ROOT, "integrations");

// S1.2 collapsed the slash-command surface. The seven live verbs map
// 1-1 to MCP tools; archive / restore / delete / status were dropped
// when the three-state session model landed (end + resume + list cover
// their intents).
const SESSION_VERBS = ["start", "list", "resume", "checkpoint", "pause", "end", "search"] as const;
const RETIRED_SESSION_VERBS = ["archive", "restore", "delete", "status"] as const;

const STANDALONE_HARNESSES = [
  { dir: "claude-code", repo: "the-librarian-claude-plugin" },
  { dir: "codex", repo: "the-librarian-codex-plugin" },
  { dir: "hermes", repo: "the-librarian-hermes-plugin" },
  { dir: "opencode", repo: "the-librarian-opencode-plugin" },
  { dir: "pi", repo: "the-librarian-pi-extension" },
] as const;

function pkgPath(...parts: string[]): string {
  return path.join(INTEGRATIONS_DIR, ...parts);
}

function assertNonEmptyFile(p: string): void {
  expect(fs.existsSync(p), `expected file: ${path.relative(REPO_ROOT, p)}`).toBe(true);
  const stat = fs.statSync(p);
  expect(stat.isFile(), `expected ${path.relative(REPO_ROOT, p)} to be a file`).toBe(true);
  expect(stat.size, `expected ${path.relative(REPO_ROOT, p)} to be non-empty`).toBeGreaterThan(0);
}

describe("integrations", () => {
  it("integrations/README.md links every standalone plugin repo", () => {
    const readmePath = pkgPath("README.md");
    assertNonEmptyFile(readmePath);
    const text = fs.readFileSync(readmePath, "utf8");
    for (const { repo } of STANDALONE_HARNESSES) {
      expect(text, `README must link the ${repo} repo`).toMatch(new RegExp(repo));
    }
  });

  it("repo-local .claude/commands ships a per-verb command for each session verb", () => {
    for (const verb of SESSION_VERBS) {
      const p = path.join(REPO_ROOT, ".claude", "commands", `lib-session-${verb}.md`);
      assertNonEmptyFile(p);
    }
    for (const verb of RETIRED_SESSION_VERBS) {
      expect(
        fs.existsSync(path.join(REPO_ROOT, ".claude", "commands", `lib-session-${verb}.md`)),
        `retired verb ${verb} must not be dogfooded in .claude/commands`,
      ).toBe(false);
    }
  });

  it("none of the graduated harness directories remain under integrations/", () => {
    for (const { dir, repo } of STANDALONE_HARNESSES) {
      expect(fs.existsSync(pkgPath(dir)), `integrations/${dir}/ must not exist — see ${repo}`).toBe(
        false,
      );
    }
  });
});
