// Repo-structure contract tests.
//
// What this guards:
//
//   1. The repo-local `.claude/commands/` per-verb dogfood files for the
//      post-sessions-rethink slash surface (`/handoff`, `/takeover`,
//      `/learn`, `/toggle-private`) are present, and the retired
//      `lib-session-*` / `lib-toggle-private` files are NOT.
//   2. The `integrations/` directory carries exactly the five in-tree
//      harness surfaces (rethink T14–T16, D14): claude, codex, hermes,
//      opencode, pi. The standalone plugin repos are being archived —
//      this is the inverse of the pre-rethink rule, which pinned
//      `integrations/` absent.

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

  it("integrations/ carries exactly the five in-tree harness surfaces (rethink D14)", () => {
    const integrationsDir = path.join(REPO_ROOT, "integrations");
    expect(
      fs.existsSync(integrationsDir),
      "integrations/ must exist — the five harness surfaces live in-tree (rethink D14)",
    ).toBe(true);
    const harnesses = fs
      .readdirSync(integrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(harnesses).toEqual(["claude", "codex", "hermes", "opencode", "pi"]);
    // Every harness ships its README — the per-harness install contract
    // (spec §13: README is the contract).
    for (const harness of harnesses) {
      assertNonEmptyFile(path.join(integrationsDir, harness, "README.md"));
    }
  });
});
