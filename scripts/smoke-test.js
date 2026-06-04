#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLibrarianStore } from "@librarian/core";

// This smoke exercises the markdown vault: an in-process store plus spawned
// stdio/HTTP servers (which inherit process.env). Markdown is the only backend.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STDIO_BIN = path.join(REPO_ROOT, "packages", "mcp-server", "dist", "bin", "stdio.js");
const HTTP_BIN = path.join(REPO_ROOT, "packages", "mcp-server", "dist", "bin", "http.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-smoke-"));
const store = createLibrarianStore({ dataDir: tmp });

try {
  // Section 4d.3 — the legacy category-based proposal gate is retired.
  // Trusted internal callers (curator apply, dashboard) opt into the
  // proposal queue via `options.requires_approval: true`. Smoke test
  // exercises both paths.
  const protectedResult = store.createMemory(
    {
      agent_id: "codex",
      title: "Protected proposal",
      body: "Memories awaiting approval land in the proposal queue.",
      priority: "core",
    },
    { requires_approval: true },
  );
  assert(protectedResult.status === "proposed", "requires_approval=true memory should be proposed");

  const lessonResult = store.createMemory({
    agent_id: "codex",
    title: "Use the markdown vault as source of truth",
    body: "The durable memory ledger is the git-backed markdown vault; recall reads a disposable index rebuilt from it.",
    tags: ["markdown", "vault"],
  });
  assert(lessonResult.status === "active", "default memory should be active");

  const recalled = store.searchMemories({
    agent_id: "codex",
    query: "markdown vault",
    limit: 5,
  });
  assert(
    recalled.some((memory) => memory.id === lessonResult.memory.id),
    "search should recall saved lesson",
  );

  const context = store.startContext({
    agent_id: "codex",
    task_summary: "memory policy",
  });
  assert(context.text.includes("Memory Context"), "start_context should return prose");

  store.close();
  await smokeMcp(tmp);
  await smokeHttp(tmp);
  console.log("Smoke test passed");
} finally {
  try {
    store.close();
  } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function smokeMcp(dataDir) {
  const child = spawn(process.execPath, ["--no-warnings", STDIO_BIN], {
    cwd: REPO_ROOT,
    env: { ...process.env, LIBRARIAN_DATA_DIR: dataDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    // Buffer across chunk boundaries so a reply split mid-line still parses.
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        messages.push(JSON.parse(line));
      } catch {
        // Non-JSON stdout line — ignore (stdout should only carry JSON-RPC).
      }
    }
  });

  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    }) + "\n",
  );
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }) + "\n",
  );

  // Markdown startup (git-init the vault + first-run master-key generation) adds
  // startup latency, so poll for both replies instead of racing a fixed delay.
  await waitFor(() => messages.some((m) => m.id === 1) && messages.some((m) => m.id === 2), 8000);
  child.kill("SIGTERM");
  assert(
    messages.some(
      (message) => message.id === 1 && message.result?.serverInfo?.name === "the-librarian",
    ),
    "MCP initialize should work",
  );
  assert(
    messages.some((message) => message.id === 2 && Array.isArray(message.result?.tools)),
    "MCP tools/list should work",
  );
}

async function smokeHttp(dataDir) {
  const port = await getFreePort();
  const child = spawn(process.execPath, ["--no-warnings", HTTP_BIN], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      LIBRARIAN_DATA_DIR: dataDir,
      LIBRARIAN_HOST: "0.0.0.0",
      LIBRARIAN_PORT: String(port),
      LIBRARIAN_AUTH_TOKEN: "smoke-admin-token",
      LIBRARIAN_AGENT_TOKEN: "smoke-agent-token",
      LIBRARIAN_ALLOWED_ORIGINS: `http://0.0.0.0:${port}`,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  try {
    await waitForHttp(`http://0.0.0.0:${port}/healthz`);

    const unauthorized = await fetch(`http://0.0.0.0:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    });
    assert(unauthorized.status === 401, "HTTP MCP should require auth");

    const authorized = await fetch(`http://0.0.0.0:${port}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer smoke-agent-token",
        "content-type": "application/json",
        origin: `http://0.0.0.0:${port}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    });
    const json = await authorized.json();
    assert(authorized.ok, "authorized HTTP MCP should succeed");
    assert(json.result?.serverInfo?.name === "the-librarian", "HTTP MCP initialize should work");
  } finally {
    child.kill("SIGTERM");
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(50);
  }
  // Fall through on timeout — the caller's assert produces the descriptive error.
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "0.0.0.0", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

async function waitForHttp(url) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}
