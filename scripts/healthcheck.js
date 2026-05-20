#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLibrarianStore } from "@librarian/core";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STDIO_BIN = path.join(REPO_ROOT, "packages", "mcp-server", "dist", "bin", "stdio.js");
const HTTP_BIN = path.join(REPO_ROOT, "packages", "mcp-server", "dist", "bin", "http.js");

const LOCAL_CHECKS = [
  { name: "JSONL append", fn: checkJsonlAppend },
  { name: "SQLite rebuild", fn: checkSqliteRebuild },
  { name: "Session lifecycle", fn: checkSessionLifecycle },
  { name: "MCP stdio reachability", fn: checkMcpStdio },
  { name: "HTTP MCP reachability + auth", fn: () => checkHttpMcpLocal() },
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  const bar = "=".repeat(60);
  console.log("The Librarian healthcheck");
  console.log(bar);

  const checks = args.remote
    ? [
        {
          name: "Remote HTTP reachability + auth",
          fn: () => checkHttpMcpRemote(args.remote, args),
        },
      ]
    : LOCAL_CHECKS;

  if (args.remote) {
    console.log(`mode: remote (${args.remote})`);
    console.log(bar);
  }

  let failed = 0;
  for (const check of checks) {
    const start = Date.now();
    try {
      await check.fn();
      console.log(`PASS  ${check.name}  (${Date.now() - start}ms)`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL  ${check.name}  (${Date.now() - start}ms)`);
      console.log(`        reason: ${error.message}`);
      if (error.hint) console.log(`        hint: ${error.hint}`);
    }
  }

  console.log(bar);
  if (failed) {
    console.log(`${failed} of ${checks.length} checks failed`);
    process.exit(1);
  }
  console.log(`${checks.length} of ${checks.length} checks passed`);
  process.exit(0);
}

function parseArgs(argv) {
  const result = { help: false, remote: null, agentToken: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--remote") result.remote = argv[++i];
    else if (arg.startsWith("--remote=")) result.remote = arg.slice("--remote=".length);
    else if (arg === "--agent-token") result.agentToken = argv[++i];
    else if (arg.startsWith("--agent-token="))
      result.agentToken = arg.slice("--agent-token=".length);
  }
  if (!result.agentToken) {
    result.agentToken = process.env.LIBRARIAN_HEALTHCHECK_AGENT_TOKEN || null;
  }
  return result;
}

async function checkJsonlAppend() {
  const dir = makeTempDir();
  try {
    const store = createLibrarianStore({ dataDir: dir });
    try {
      store.createMemory({
        agent_id: "healthcheck",
        title: "healthcheck memory",
        body: "Append a memory event to events.jsonl.",
        category: "tools",
        visibility: "common",
        scope: "tool",
      });
      store.startSession({
        agent_id: "healthcheck",
        title: "healthcheck session",
        harness: "test",
      });
    } finally {
      store.close();
    }
    assertNonEmpty(path.join(dir, "events.jsonl"), "events.jsonl is empty after createMemory");
    assertNonEmpty(path.join(dir, "sessions.jsonl"), "sessions.jsonl is empty after startSession");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function checkSqliteRebuild() {
  const dir = makeTempDir();
  try {
    let store = createLibrarianStore({ dataDir: dir });
    let sessionId;
    let memoryId;
    try {
      memoryId = store.createMemory({
        agent_id: "healthcheck",
        title: "rebuildable",
        body: "Survives a SQLite wipe.",
        category: "tools",
        visibility: "common",
        scope: "tool",
      }).memory.id;
      sessionId = store.startSession({
        agent_id: "healthcheck",
        title: "rebuildable session",
        harness: "test",
      }).session.id;
    } finally {
      store.close();
    }

    fs.unlinkSync(path.join(dir, "librarian.sqlite"));

    store = createLibrarianStore({ dataDir: dir });
    try {
      const session = store.getSession(sessionId);
      const memory = store.getMemory(memoryId);
      if (!session) {
        throw hint(
          new Error("Session did not survive a SQLite wipe."),
          "sessions.jsonl is not being replayed on startup.",
        );
      }
      if (!memory) {
        throw hint(
          new Error("Memory did not survive a SQLite wipe."),
          "events.jsonl is not being replayed on startup.",
        );
      }
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function checkSessionLifecycle() {
  const dir = makeTempDir();
  try {
    const store = createLibrarianStore({ dataDir: dir });
    try {
      const { session } = store.startSession({
        agent_id: "healthcheck",
        title: "lifecycle",
        harness: "test",
        start_summary: "starting",
      });

      store.checkpointSession({
        agent_id: "healthcheck",
        session_id: session.id,
        summary: "midway",
      });
      let reloaded = store.getSession(session.id);
      if (reloaded.rolling_summary !== "midway") {
        throw hint(
          new Error("Checkpoint did not update rolling_summary."),
          "Lifecycle apply path is broken.",
        );
      }

      store.pauseSession({
        agent_id: "healthcheck",
        session_id: session.id,
        summary: "pausing",
      });
      reloaded = store.getSession(session.id);
      if (reloaded.status !== "paused") {
        throw hint(
          new Error("pauseSession did not transition status to paused."),
          "Pause event handler is broken.",
        );
      }

      store.recordSessionEvent({
        agent_id: "healthcheck",
        session_id: session.id,
        type: "note",
        summary: "back",
      });
      reloaded = store.getSession(session.id);
      if (reloaded.status !== "active") {
        throw hint(
          new Error("Implicit resume on activity did not fire."),
          "recordSessionEvent should transition paused → active.",
        );
      }

      store.endSession({
        agent_id: "healthcheck",
        session_id: session.id,
        summary: "done",
      });
      reloaded = store.getSession(session.id);
      if (reloaded.status !== "ended") {
        throw hint(
          new Error("endSession did not mark the session ended."),
          "End event handler is broken.",
        );
      }
      if (reloaded.end_summary !== "done") {
        throw hint(new Error("endSession did not write end_summary."), "End payload is dropped.");
      }
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function checkMcpStdio() {
  const dir = makeTempDir();
  const child = spawn(process.execPath, ["--no-warnings", STDIO_BIN], {
    cwd: REPO_ROOT,
    env: { ...process.env, LIBRARIAN_DATA_DIR: dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    for (const line of chunk.split("\n").filter(Boolean)) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        /* ignore non-JSON */
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n",
    );

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const initOk = messages.some(
        (m) => m.id === 1 && m.result?.serverInfo?.name === "the-librarian",
      );
      const listOk = messages.some((m) => m.id === 2 && Array.isArray(m.result?.tools));
      if (initOk && listOk) return;
      await wait(50);
    }

    throw hint(
      new Error("MCP stdio did not respond to initialize + tools/list."),
      `packages/mcp-server/dist/bin/stdio.js may be failing on startup. stderr:\n${stderr || "(empty)"}`,
    );
  } finally {
    child.kill("SIGTERM");
    await waitForExit(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function checkHttpMcpLocal() {
  const dir = makeTempDir();
  const port = await getFreePort();
  const child = spawn(process.execPath, ["--no-warnings", HTTP_BIN], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      LIBRARIAN_DATA_DIR: dir,
      LIBRARIAN_HOST: "127.0.0.1",
      LIBRARIAN_PORT: String(port),
      LIBRARIAN_AUTH_TOKEN: "hc-admin-token",
      LIBRARIAN_AGENT_TOKEN: "hc-agent-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const url = `http://127.0.0.1:${port}`;
    await waitForHttp(`${url}/healthz`, stderr);
    await probeHttpMcp(url, { agentToken: "hc-agent-token" });
  } finally {
    child.kill("SIGTERM");
    await waitForExit(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function checkHttpMcpRemote(remoteUrl, args) {
  const url = remoteUrl.replace(/\/+$/, "");
  await waitForHttp(`${url}/healthz`, "");

  const agentToken =
    args.agentToken ||
    process.env.LIBRARIAN_HEALTHCHECK_AGENT_TOKEN ||
    process.env.LIBRARIAN_AGENT_TOKEN ||
    process.env.LIBRARIAN_ADMIN_TOKEN;
  if (!agentToken) {
    throw hint(
      new Error("No bearer token available to probe /mcp."),
      "Pass --agent-token <token> or set LIBRARIAN_HEALTHCHECK_AGENT_TOKEN (admin or agent) before running --remote.",
    );
  }
  await probeHttpMcp(url, { agentToken });
}

async function probeHttpMcp(url, { agentToken }) {
  const unauthorized = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  if (unauthorized.status !== 401) {
    throw hint(
      new Error(`Unauthorized request returned ${unauthorized.status}, expected 401.`),
      "MCP auth is not being enforced.",
    );
  }

  const authorized = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  if (!authorized.ok) {
    throw hint(
      new Error(`Authorized request failed with status ${authorized.status}.`),
      "Bearer auth or dispatch wiring is broken.",
    );
  }
  const json = await authorized.json();
  if (json.result?.serverInfo?.name !== "the-librarian") {
    throw hint(
      new Error("HTTP MCP initialize returned an unexpected payload."),
      "Dispatch chain may not be wired correctly.",
    );
  }
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "librarian-healthcheck-"));
}

function assertNonEmpty(filePath, message) {
  if (!fs.existsSync(filePath)) throw new Error(`${message} (file missing: ${filePath})`);
  if (fs.statSync(filePath).size === 0) throw new Error(message);
}

function hint(error, hintText) {
  error.hint = hintText;
  return error;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

async function waitForHttp(url, stderr) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* server may not be ready yet */
    }
    await wait(100);
  }
  throw hint(new Error(`Timed out waiting for ${url}.`), `Server stderr:\n${stderr || "(empty)"}`);
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve();
    }, 2000);
  });
}

function usage() {
  return [
    "Usage: node scripts/healthcheck.js [--remote <url>] [--agent-token <token>] [--help]",
    "",
    "Default (local) mode runs end-to-end checks against a temporary Librarian:",
    "  - JSONL append (events.jsonl, sessions.jsonl)",
    "  - SQLite rebuild from JSONL",
    "  - Session lifecycle round-trip (start → checkpoint → pause → resume → end)",
    "  - MCP stdio reachability (packages/mcp-server/dist/bin/stdio.js)",
    "  - HTTP MCP reachability + auth (packages/mcp-server/dist/bin/http.js)",
    "",
    "Remote mode (--remote http://host:port) skips in-process checks and only",
    "probes the supplied URL: /healthz reachability, /mcp 401 without a token,",
    "and /mcp initialize with a bearer token. The bearer comes from",
    "--agent-token, LIBRARIAN_HEALTHCHECK_AGENT_TOKEN, LIBRARIAN_AGENT_TOKEN, or",
    "LIBRARIAN_ADMIN_TOKEN (first non-empty wins).",
    "",
    "Each named check prints PASS or FAIL with a reason and a hint when it fails.",
    "Exit 0 when every check passes, 1 otherwise.",
  ].join("\n");
}

main().catch((error) => {
  console.error(`healthcheck crashed: ${error.message}`);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
