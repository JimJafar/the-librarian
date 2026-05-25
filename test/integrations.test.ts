// Integration-package contract tests.
//
// Ported from test/integrations.test.js (node:test) to Vitest as part
// of T5.2's "flip pnpm test to Vitest exclusively" cleanup. Pins the
// per-harness package layouts that wrappers + slash commands depend
// on; behaviour is identical to the JS version.

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

function pkgPath(...parts: string[]): string {
  return path.join(INTEGRATIONS_DIR, ...parts);
}

function assertNonEmptyFile(p: string): void {
  expect(fs.existsSync(p), `expected file: ${path.relative(REPO_ROOT, p)}`).toBe(true);
  const stat = fs.statSync(p);
  expect(stat.isFile(), `expected ${path.relative(REPO_ROOT, p)} to be a file`).toBe(true);
  expect(stat.size, `expected ${path.relative(REPO_ROOT, p)} to be non-empty`).toBeGreaterThan(0);
}

function assertReferencesLib(p: string): void {
  const content = fs.readFileSync(p, "utf8");
  expect(content, `${path.relative(REPO_ROOT, p)} should reference /lib:session`).toMatch(
    /\/lib:session/,
  );
}

describe("integrations packages", () => {
  it("integrations/README.md lists the local packages and links the standalone plugins", () => {
    const readmePath = pkgPath("README.md");
    assertNonEmptyFile(readmePath);
    const text = fs.readFileSync(readmePath, "utf8");
    // Codex, OpenCode, Pi still ship as copyable packages here.
    for (const harness of ["codex", "opencode", "pi"]) {
      expect(text, `README must mention the ${harness} package`).toMatch(new RegExp(harness, "i"));
    }
    // Claude Code + Hermes graduated to standalone plugin repos — link, don't ship.
    expect(text, "README must link the Claude Code plugin repo").toMatch(
      /the-librarian-claude-plugin/,
    );
    expect(text, "README must link the Hermes plugin repo").toMatch(/the-librarian-hermes-plugin/);
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

  it("integrations/codex package ships the documented files", () => {
    for (const file of [
      "README.md",
      "AGENTS.md",
      "slash-commands.md",
      "mcp.example.json",
      "wrapper.sh",
      "healthcheck.md",
    ]) {
      assertNonEmptyFile(pkgPath("codex", file));
    }
    assertReferencesLib(pkgPath("codex", "AGENTS.md"));
  });

  it("integrations/codex wrapper.sh is executable and exports LIBRARIAN_SESSION_ID", () => {
    const wrapperPath = pkgPath("codex", "wrapper.sh");
    const stat = fs.statSync(wrapperPath);
    expect(stat.mode & 0o111).not.toBe(0);
    const content = fs.readFileSync(wrapperPath, "utf8");
    expect(content).toMatch(/LIBRARIAN_SESSION_ID/);
    expect(content).toMatch(/sessions\s+(start|pause|end)/);
  });

  it("integrations/pi package ships the documented files", () => {
    for (const file of [
      "README.md",
      "AGENTS.md",
      "slash-commands.md",
      "config.example.yaml",
      "wrapper.sh",
      "healthcheck.md",
    ]) {
      assertNonEmptyFile(pkgPath("pi", file));
    }
    assertReferencesLib(pkgPath("pi", "AGENTS.md"));
  });

  it("integrations/pi documents the open runtime question and conservative capture default", () => {
    const readme = fs.readFileSync(pkgPath("pi", "README.md"), "utf8");
    expect(readme).toMatch(/capture/i);
    const agents = fs.readFileSync(pkgPath("pi", "AGENTS.md"), "utf8");
    expect(agents).toMatch(/capture/i);
  });

  it("integrations/pi wrapper.sh is executable and references the lifecycle", () => {
    const wrapperPath = pkgPath("pi", "wrapper.sh");
    const stat = fs.statSync(wrapperPath);
    expect(stat.mode & 0o111).not.toBe(0);
    const content = fs.readFileSync(wrapperPath, "utf8");
    expect(content).toMatch(/LIBRARIAN_SESSION_ID/);
    expect(content).toMatch(/sessions\s+(start|pause|end)/);
  });

  it("integrations/opencode package ships the documented files", () => {
    for (const file of [
      "README.md",
      "AGENTS.md",
      "slash-commands.md",
      "opencode.example.json",
      "commands.example.json",
      "wrapper.sh",
      "healthcheck.md",
    ]) {
      assertNonEmptyFile(pkgPath("opencode", file));
    }
    assertReferencesLib(pkgPath("opencode", "AGENTS.md"));
  });

  it("integrations/opencode example configs are valid JSON", () => {
    const opencode = JSON.parse(
      fs.readFileSync(pkgPath("opencode", "opencode.example.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(opencode).toBeTruthy();
    const flat = JSON.stringify(opencode);
    expect(flat).toMatch(/librarian/i);
    expect(flat).toMatch(/\/mcp/);

    const commands = JSON.parse(
      fs.readFileSync(pkgPath("opencode", "commands.example.json"), "utf8"),
    ) as { command: Record<string, unknown> };
    expect(commands).toBeTruthy();
    expect(commands.command).toBeTruthy();
    for (const verb of SESSION_VERBS) {
      expect(
        commands.command[`lib-session-${verb}`],
        `commands.example.json must define lib-session-${verb}`,
      ).toBeTruthy();
    }
    for (const verb of RETIRED_SESSION_VERBS) {
      expect(
        commands.command[`lib-session-${verb}`],
        `commands.example.json must not define retired verb lib-session-${verb}`,
      ).toBeUndefined();
    }
  });

  it("integrations/opencode ships one native slash command markdown per session verb", () => {
    for (const verb of SESSION_VERBS) {
      assertNonEmptyFile(pkgPath("opencode", "commands", `lib-session-${verb}.md`));
    }
    for (const verb of RETIRED_SESSION_VERBS) {
      expect(
        fs.existsSync(pkgPath("opencode", "commands", `lib-session-${verb}.md`)),
        `retired verb ${verb} must not have a command file`,
      ).toBe(false);
    }
    const startCmd = fs.readFileSync(
      pkgPath("opencode", "commands", "lib-session-start.md"),
      "utf8",
    );
    expect(startCmd).toMatch(/start_session/);
    expect(startCmd).toMatch(/sensitivity/i);
    expect(startCmd).toMatch(/harness: "opencode"/);
  });

  it("integrations/opencode wrapper.sh is executable and records attachment", () => {
    const wrapperPath = pkgPath("opencode", "wrapper.sh");
    const stat = fs.statSync(wrapperPath);
    expect(stat.mode & 0o111).not.toBe(0);
    const content = fs.readFileSync(wrapperPath, "utf8");
    expect(content).toMatch(/LIBRARIAN_SESSION_ID/);
    expect(content).toMatch(/sessions\s+(start|pause|attach)/);
  });
});
