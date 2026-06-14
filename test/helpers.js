import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLibrarianStore } from "@librarian/core";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTTP_BIN = path.join(REPO_ROOT, "packages", "mcp-server", "dist", "bin", "http.js");

export function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "librarian-test-"));
}

export function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function withStore(testFn) {
  const dataDir = makeTempDir();
  const store = createLibrarianStore({ dataDir });
  const close = () => {
    try {
      store.close();
    } catch {}
    cleanupTempDir(dataDir);
  };
  return Promise.resolve()
    .then(() => testFn(store, dataDir))
    .finally(close);
}

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "0.0.0.0", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

export async function startHttpServer({
  dataDir,
  token = "test-token",
  agentToken = "agent-token",
  agentTokens = "",
  allowedOrigins = "",
  secretKey = "",
} = {}) {
  const port = await getFreePort();
  // ADR 0008 P1: the admin tRPC surface now lives on a SEPARATE internal
  // listener (loopback), off the published port. Pick a free port for it so
  // each spawned test server gets its own pair without racing.
  const trpcPort = await getFreePort();
  const child = spawn(process.execPath, ["--no-warnings", HTTP_BIN], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...(secretKey ? { LIBRARIAN_SECRET_KEY: secretKey } : {}),
      LIBRARIAN_DATA_DIR: dataDir,
      LIBRARIAN_HOST: "0.0.0.0",
      LIBRARIAN_PORT: String(port),
      // Bind the internal tRPC listener on 0.0.0.0 too so the test harness (a
      // sibling process, not strictly loopback) can reach it. Production
      // defaults to 127.0.0.1; this only widens the bind for the test.
      LIBRARIAN_TRPC_HOST: "0.0.0.0",
      LIBRARIAN_TRPC_PORT: String(trpcPort),
      LIBRARIAN_AUTH_TOKEN: token,
      LIBRARIAN_AGENT_TOKEN: agentToken,
      LIBRARIAN_AGENT_TOKENS: agentTokens,
      LIBRARIAN_ALLOWED_ORIGINS: allowedOrigins,
      // Pin the automatic curation timers OFF for the spawned test server unless a
      // caller opts in. Without this, the unconditional grooming/intake schedulers
      // run a boot-scan pass at startup — which, for a test that seeds grooming
      // enabled+configured before boot, grooms the test corpus before the test's own
      // action and pollutes its assertions (auto-applied/proposed memories the test
      // didn't expect). Tests drive curation explicitly via run-now / dry-run /
      // re-evaluate, which bypass the schedulers. A test that needs the timers can
      // override these. (TICK_MS=0 also skips the boot scan; see bin/http.ts.)
      LIBRARIAN_GROOMING_TICK_MS: process.env.LIBRARIAN_GROOMING_TICK_MS || "0",
      LIBRARIAN_CONSOLIDATOR_TICK_MS: process.env.LIBRARIAN_CONSOLIDATOR_TICK_MS || "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  // Wait for BOTH listeners: the public one (/healthz) and the internal tRPC
  // one (health.ping is the public tRPC probe). A test that hits /trpc must not
  // race the internal listener's bind.
  await waitForHttp(`http://0.0.0.0:${port}/healthz`, () => stderr);
  await waitForHttp(`http://0.0.0.0:${trpcPort}/trpc/health.ping`, () => stderr);

  return {
    port,
    url: `http://0.0.0.0:${port}`,
    trpcPort,
    // The internal listener that serves /trpc/*. Append `/trpc/<proc>` to call it.
    trpcUrl: `http://0.0.0.0:${trpcPort}`,
    token,
    agentToken,
    child,
    stop: async () => {
      child.kill("SIGTERM");
      await waitForExit(child);
    },
  };
}

export async function postJson(url, payload, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  return { response, json };
}

export function assertIncludes(haystack, needle) {
  assert.match(haystack, new RegExp(escapeRegExp(needle)));
}

async function waitForHttp(url, getStderr) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await wait(100);
  }
  const stderr = typeof getStderr === "function" ? getStderr() : getStderr;
  throw new Error(`Timed out waiting for ${url}\n${stderr}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
