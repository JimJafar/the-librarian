// Repo-structure contract tests.
//
// What this guards:
//
//   1. The repo-local `.claude/commands/` per-verb dogfood files are
//      present (and the retired verbs are NOT).
//   2. The `integrations/` directory is gone for good. All five
//      harnesses (Claude Code, Codex, Hermes, OpenCode, Pi) ship as
//      standalone plugin repos. Reintroducing an in-tree harness copy
//      would drift from its standalone repo's source of truth.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

// S1.2 collapsed the slash-command surface. The seven live verbs map
// 1-1 to MCP tools; archive / restore / delete / status were dropped
// when the three-state session model landed (end + resume + list cover
// their intents).
const SESSION_VERBS = ["start", "list", "resume", "checkpoint", "pause", "end", "search"] as const;
const RETIRED_SESSION_VERBS = ["archive", "restore", "delete", "status"] as const;

function assertNonEmptyFile(p: string): void {
  expect(fs.existsSync(p), `expected file: ${path.relative(REPO_ROOT, p)}`).toBe(true);
  const stat = fs.statSync(p);
  expect(stat.isFile(), `expected ${path.relative(REPO_ROOT, p)} to be a file`).toBe(true);
  expect(stat.size, `expected ${path.relative(REPO_ROOT, p)} to be non-empty`).toBeGreaterThan(0);
}

describe("repo structure", () => {
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

  it("integrations/ directory is gone — all five harnesses live in standalone repos", () => {
    expect(
      fs.existsSync(path.join(REPO_ROOT, "integrations")),
      "integrations/ must not exist — per-harness code belongs in its standalone plugin repo",
    ).toBe(false);
  });
});
