import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const INTEGRATIONS_DIR = path.join(REPO_ROOT, "integrations");

function pkgPath(...parts) {
  return path.join(INTEGRATIONS_DIR, ...parts);
}

function assertNonEmptyFile(p) {
  assert.ok(fs.existsSync(p), `expected file: ${path.relative(REPO_ROOT, p)}`);
  const stat = fs.statSync(p);
  assert.ok(stat.isFile(), `expected ${path.relative(REPO_ROOT, p)} to be a file`);
  assert.ok(stat.size > 0, `expected ${path.relative(REPO_ROOT, p)} to be non-empty`);
}

function assertReferencesLib(p) {
  const content = fs.readFileSync(p, "utf8");
  assert.match(content, /\/lib:session/, `${path.relative(REPO_ROOT, p)} should reference the /lib:session slash command surface`);
}

test("integrations/README.md exists and references each supported harness", () => {
  const readmePath = pkgPath("README.md");
  assertNonEmptyFile(readmePath);
  const text = fs.readFileSync(readmePath, "utf8");
  for (const harness of ["hermes", "claude-code", "codex", "pi", "opencode"]) {
    assert.match(text, new RegExp(harness, "i"), `top-level README must mention ${harness}`);
  }
});

test("integrations/hermes package ships the documented files", () => {
  for (const file of [
    "README.md",
    "AGENTS.append.md",
    "slash-commands.md",
    "config.example.yaml",
    "healthcheck.md"
  ]) {
    assertNonEmptyFile(pkgPath("hermes", file));
  }
  assertReferencesLib(pkgPath("hermes", "AGENTS.append.md"));
  assertReferencesLib(pkgPath("hermes", "slash-commands.md"));
});

test("integrations/hermes AGENTS.append.md documents Discord source_ref shape and long-thread policy", () => {
  const content = fs.readFileSync(pkgPath("hermes", "AGENTS.append.md"), "utf8");
  assert.match(content, /discord:channel:/, "Discord source_ref shape must be documented");
  assert.match(content, /thread/i, "long-thread guidance must be documented");
});

test("integrations/claude-code package ships the documented files", () => {
  for (const file of [
    "README.md",
    "CLAUDE.md",
    "slash-commands.md",
    "mcp.example.json",
    "wrapper.sh",
    "healthcheck.md"
  ]) {
    assertNonEmptyFile(pkgPath("claude-code", file));
  }
  assertReferencesLib(pkgPath("claude-code", "CLAUDE.md"));
  assertReferencesLib(pkgPath("claude-code", "slash-commands.md"));
});

test("integrations/claude-code wrapper.sh is executable and brackets the harness with sessions start/pause", () => {
  const wrapperPath = pkgPath("claude-code", "wrapper.sh");
  const stat = fs.statSync(wrapperPath);
  assert.ok((stat.mode & 0o111) !== 0, "wrapper.sh must be executable");
  const content = fs.readFileSync(wrapperPath, "utf8");
  assert.match(content, /sessions\s+start/);
  assert.match(content, /sessions\s+pause/);
  assert.match(content, /LIBRARIAN_SESSION_ID/);
});

test("integrations/claude-code mcp.example.json is valid JSON and references the librarian endpoint", () => {
  const content = fs.readFileSync(pkgPath("claude-code", "mcp.example.json"), "utf8");
  const parsed = JSON.parse(content);
  assert.ok(parsed, "mcp.example.json must parse");
  const flat = JSON.stringify(parsed);
  assert.match(flat, /librarian/i, "config must reference the librarian server");
  assert.match(flat, /\/mcp/, "config must reference the /mcp HTTP endpoint");
});

test("integrations/claude-code ships one native slash command per session verb", () => {
  const verbs = [
    "start", "list", "resume", "checkpoint", "pause", "end",
    "archive", "restore", "delete", "search", "status"
  ];
  for (const verb of verbs) {
    assertNonEmptyFile(pkgPath("claude-code", "commands", `lib-session-${verb}.md`));
  }
  const startCmd = fs.readFileSync(pkgPath("claude-code", "commands", "lib-session-start.md"), "utf8");
  assert.match(startCmd, /start_session/, "lib-session-start command must name the MCP tool it calls");
  assert.match(startCmd, /sensitivity/i, "lib-session-start must remind about the sensitivity check");
});

test("repo-local .claude/commands ships the same per-verb commands", () => {
  const verbs = [
    "start", "list", "resume", "checkpoint", "pause", "end",
    "archive", "restore", "delete", "search", "status"
  ];
  for (const verb of verbs) {
    const p = path.join(REPO_ROOT, ".claude", "commands", `lib-session-${verb}.md`);
    assertNonEmptyFile(p);
  }
});

test("integrations/codex package ships the documented files", () => {
  for (const file of [
    "README.md",
    "AGENTS.md",
    "slash-commands.md",
    "mcp.example.json",
    "wrapper.sh",
    "healthcheck.md"
  ]) {
    assertNonEmptyFile(pkgPath("codex", file));
  }
  assertReferencesLib(pkgPath("codex", "AGENTS.md"));
});

test("integrations/codex wrapper.sh is executable and exports LIBRARIAN_SESSION_ID", () => {
  const wrapperPath = pkgPath("codex", "wrapper.sh");
  const stat = fs.statSync(wrapperPath);
  assert.ok((stat.mode & 0o111) !== 0, "wrapper.sh must be executable");
  const content = fs.readFileSync(wrapperPath, "utf8");
  assert.match(content, /LIBRARIAN_SESSION_ID/);
  assert.match(content, /sessions\s+(start|pause|end)/);
});

test("integrations/pi package ships the documented files", () => {
  for (const file of [
    "README.md",
    "AGENTS.md",
    "slash-commands.md",
    "config.example.yaml",
    "wrapper.sh",
    "healthcheck.md"
  ]) {
    assertNonEmptyFile(pkgPath("pi", file));
  }
  assertReferencesLib(pkgPath("pi", "AGENTS.md"));
});

test("integrations/pi documents the open runtime question and conservative capture default", () => {
  const readme = fs.readFileSync(pkgPath("pi", "README.md"), "utf8");
  assert.match(readme, /capture/i, "Pi README must mention the conservative capture default");
  const agents = fs.readFileSync(pkgPath("pi", "AGENTS.md"), "utf8");
  assert.match(agents, /capture/i, "Pi AGENTS.md must document the conservative capture default");
});

test("integrations/pi wrapper.sh is executable and references the lifecycle", () => {
  const wrapperPath = pkgPath("pi", "wrapper.sh");
  const stat = fs.statSync(wrapperPath);
  assert.ok((stat.mode & 0o111) !== 0, "wrapper.sh must be executable");
  const content = fs.readFileSync(wrapperPath, "utf8");
  assert.match(content, /LIBRARIAN_SESSION_ID/);
  assert.match(content, /sessions\s+(start|pause|end)/);
});

test("integrations/opencode package ships the documented files", () => {
  for (const file of [
    "README.md",
    "AGENTS.md",
    "slash-commands.md",
    "opencode.example.json",
    "commands.example.json",
    "wrapper.sh",
    "healthcheck.md"
  ]) {
    assertNonEmptyFile(pkgPath("opencode", file));
  }
  assertReferencesLib(pkgPath("opencode", "AGENTS.md"));
});

test("integrations/opencode example configs are valid JSON", () => {
  const opencode = JSON.parse(fs.readFileSync(pkgPath("opencode", "opencode.example.json"), "utf8"));
  assert.ok(opencode, "opencode.example.json must parse");
  const flat = JSON.stringify(opencode);
  assert.match(flat, /librarian/i);
  assert.match(flat, /\/mcp/);

  const commands = JSON.parse(fs.readFileSync(pkgPath("opencode", "commands.example.json"), "utf8"));
  assert.ok(commands, "commands.example.json must parse");
  assert.match(JSON.stringify(commands), /lib:session/);
});

test("integrations/opencode wrapper.sh is executable and records attachment", () => {
  const wrapperPath = pkgPath("opencode", "wrapper.sh");
  const stat = fs.statSync(wrapperPath);
  assert.ok((stat.mode & 0o111) !== 0, "wrapper.sh must be executable");
  const content = fs.readFileSync(wrapperPath, "utf8");
  assert.match(content, /LIBRARIAN_SESSION_ID/);
  assert.match(content, /sessions\s+(start|pause|attach)/);
});
