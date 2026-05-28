// Repo-structure contract tests.
//
// What this guards:
//
//   1. The repo-local `.claude/commands/` per-verb dogfood files for the
//      post-sessions-rethink slash surface (`/handoff`, `/takeover`,
//      `/learn`, `/toggle-private`) are present, and the retired
//      `lib-session-*` / `lib-toggle-private` files are NOT.
//   2. The `integrations/` directory is gone for good. All five
//      harnesses (Claude Code, Codex, Hermes, OpenCode, Pi) ship as
//      standalone plugin repos. Reintroducing an in-tree harness copy
//      would drift from its standalone repo's source of truth.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const SLASH_COMMANDS = ["handoff", "takeover", "learn", "toggle-private"] as const;
const RETIRED_SESSION_VERBS = [
  "lib-session-start",
  "lib-session-list",
  "lib-session-resume",
  "lib-session-checkpoint",
  "lib-session-pause",
  "lib-session-end",
  "lib-session-search",
  "lib-toggle-private",
] as const;

function assertNonEmptyFile(p: string): void {
  expect(fs.existsSync(p), `expected file: ${path.relative(REPO_ROOT, p)}`).toBe(true);
  const stat = fs.statSync(p);
  expect(stat.isFile(), `expected ${path.relative(REPO_ROOT, p)} to be a file`).toBe(true);
  expect(stat.size, `expected ${path.relative(REPO_ROOT, p)} to be non-empty`).toBeGreaterThan(0);
}

describe("repo structure", () => {
  it("repo-local .claude/commands ships a per-verb command for each post-rethink slash command", () => {
    for (const command of SLASH_COMMANDS) {
      const p = path.join(REPO_ROOT, ".claude", "commands", `${command}.md`);
      assertNonEmptyFile(p);
    }
    for (const stem of RETIRED_SESSION_VERBS) {
      expect(
        fs.existsSync(path.join(REPO_ROOT, ".claude", "commands", `${stem}.md`)),
        `retired session/private command ${stem}.md must not remain in .claude/commands`,
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
