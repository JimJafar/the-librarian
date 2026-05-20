#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLibrarianStore } from "@librarian/core";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STDIO_BIN = path.join(REPO_ROOT, "packages", "mcp-server", "src", "bin", "stdio.js");
const HTTP_BIN = path.join(REPO_ROOT, "packages", "mcp-server", "dist", "bin", "http.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-smoke-"));
const store = createLibrarianStore({ dataDir: tmp });

try {
  const protectedResult = store.createMemory({
    agent_id: "codex",
    title: "Protected identity proposal",
    body: "Identity memories are proposed before activation.",
    category: "identity",
    visibility: "common",
    scope: "global",
    priority: "core",
  });
  assert(protectedResult.status === "proposed", "identity memory should be proposed");

  const lessonResult = store.createMemory({
    agent_id: "codex",
    title: "Use JSONL as source of truth",
    body: "The durable memory ledger is append-only JSONL and SQLite is rebuilt from it.",
    category: "lessons",
    visibility: "common",
    scope: "tool",
    tags: ["jsonl", "sqlite"],
  });
  assert(lessonResult.status === "active", "lesson memory should be active");

  const recalled = store.searchMemories({
    agent_id: "codex",
    query: "JSONL SQLite",
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
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    for (const line of chunk.split("\n").filter(Boolean)) messages.push(JSON.parse(line));
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

  await wait(300);
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
