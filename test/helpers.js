import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { LibrarianStore } from "../src/store.js";

export function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "librarian-test-"));
}

export function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function withStore(testFn) {
  const dataDir = makeTempDir();
  const store = new LibrarianStore({ dataDir });
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
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

export async function startHttpServer({ dataDir, token = "test-token", agentToken = "agent-token", allowedOrigins = "" } = {}) {
  const port = await getFreePort();
  const child = spawn(process.execPath, ["--no-warnings", "src/dashboard.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      LIBRARIAN_DATA_DIR: dataDir,
      LIBRARIAN_HOST: "127.0.0.1",
      LIBRARIAN_PORT: String(port),
      LIBRARIAN_AUTH_TOKEN: token,
      LIBRARIAN_AGENT_TOKEN: agentToken,
      LIBRARIAN_ALLOWED_ORIGINS: allowedOrigins
    },
    stdio: ["ignore", "ignore", "pipe"]
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  await waitForHttp(`http://127.0.0.1:${port}/healthz`, stderr);

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    token,
    agentToken,
    child,
    stop: async () => {
      child.kill("SIGTERM");
      await waitForExit(child);
    }
  };
}

export function basicAuthHeader(password, username = "dashboard") {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

export async function postJson(url, payload, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  return { response, json };
}

export function assertIncludes(haystack, needle) {
  assert.match(haystack, new RegExp(escapeRegExp(needle)));
}

async function waitForHttp(url, stderr) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await wait(100);
  }
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
