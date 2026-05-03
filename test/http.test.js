import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { basicAuthHeader, cleanupTempDir, makeTempDir, postJson, startHttpServer } from "./helpers.js";

test("HTTP service exposes health without auth and protects dashboard/API/MCP with auth", async () => {
  const dataDir = makeTempDir();
  const server = await startHttpServer({ dataDir, token: "http-token", agentToken: "http-agent-token" });
  try {
    const health = await fetch(`${server.url}/healthz`);
    assert.equal(health.status, 200);
    const healthJson = await health.json();
    assert.equal(healthJson.auth, "enabled");
    assert.equal(healthJson.agent_auth, "enabled");

    assert.equal((await fetch(`${server.url}/`)).status, 401);
    assert.equal((await fetch(`${server.url}/api/state`)).status, 401);

    const dashboard = await fetch(`${server.url}/`, {
      headers: { authorization: basicAuthHeader("http-token") }
    });
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /The Librarian/);

    const unauthMcp = await postJson(`${server.url}/mcp`, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {}
    });
    assert.equal(unauthMcp.response.status, 401);

    const authMcp = await postJson(`${server.url}/mcp`, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {}
    }, { authorization: "Bearer http-agent-token" });
    assert.equal(authMcp.response.status, 200);
    assert.equal(authMcp.json.result.serverInfo.name, "the-librarian");

    const agentApi = await fetch(`${server.url}/api/state`, {
      headers: { authorization: "Bearer http-agent-token" }
    });
    assert.equal(agentApi.status, 403);
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("HTTP Origin allow-list rejects untrusted browser origins", async () => {
  const dataDir = makeTempDir();
  const server = await startHttpServer({
    dataDir,
    token: "origin-token",
    allowedOrigins: "http://trusted.local"
  });
  try {
    const rejected = await postJson(`${server.url}/mcp`, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {}
    }, {
      authorization: "Bearer agent-token",
      origin: "http://evil.local"
    });
    assert.equal(rejected.response.status, 403);

    const accepted = await postJson(`${server.url}/mcp`, {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {}
    }, {
      authorization: "Bearer agent-token",
      origin: "http://trusted.local"
    });
    assert.equal(accepted.response.status, 200);
    assert.equal(accepted.json.result.serverInfo.name, "the-librarian");
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("HTTP dashboard can create proposals, approve them, and recall through MCP", async () => {
  const dataDir = makeTempDir();
  const server = await startHttpServer({ dataDir, token: "workflow-token", agentToken: "workflow-agent-token" });
  try {
    const create = await postJson(`${server.url}/api/memories`, {
      agent_id: "dashboard",
      title: "Identity proposal through dashboard",
      body: "Protected identity memories created through the dashboard start as proposals.",
      category: "identity",
      visibility: "common",
      scope: "global",
      priority: "core"
    }, { authorization: basicAuthHeader("workflow-token") });

    assert.equal(create.response.status, 200);
    assert.equal(create.json.status, "proposed");

    const approve = await postJson(`${server.url}/api/proposals/${create.json.memory.id}/approve`, {
      agent_id: "dashboard"
    }, { authorization: basicAuthHeader("workflow-token") });
    assert.equal(approve.response.status, 200);
    assert.equal(approve.json.status, "active");

    const context = await postJson(`${server.url}/mcp`, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "start_context",
        arguments: {
          agent_id: "codex",
          task_summary: "test dashboard proposal approval"
        }
      }
    }, { authorization: "Bearer workflow-token" });

    assert.equal(context.response.status, 200);
    assert.match(context.json.result.content[0].text, /Protected identity memories/);
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("HTTP agent token cannot force protected memories active or approve proposals", async () => {
  const dataDir = makeTempDir();
  const server = await startHttpServer({ dataDir, token: "admin-token", agentToken: "agent-token" });
  try {
    const agentCreateViaDashboard = await postJson(`${server.url}/api/memories`, {
      agent_id: "codex",
      title: "Bypass attempt",
      body: "Agent token should not reach dashboard APIs.",
      category: "identity",
      visibility: "common",
      scope: "global",
      force_active: true
    }, { authorization: "Bearer agent-token" });

    assert.equal(agentCreateViaDashboard.response.status, 403);

    const proposal = await postJson(`${server.url}/mcp`, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "remember",
        arguments: {
          agent_id: "codex",
          title: "Agent proposal",
          body: "Agent-created identity memory should remain proposed.",
          category: "identity",
          visibility: "common",
          scope: "global"
        }
      }
    }, { authorization: "Bearer agent-token" });

    assert.equal(proposal.response.status, 200);
    assert.match(proposal.json.result.content[0].text, /proposal for review/);

    const proposals = await fetch(`${server.url}/api/state`, {
      headers: { authorization: basicAuthHeader("admin-token") }
    });
    const proposedMemory = (await proposals.json()).memories.find((memory) => memory.title === "Agent proposal");
    assert.equal(proposedMemory.status, "proposed");

    const approve = await postJson(`${server.url}/mcp`, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "approve_proposal",
        arguments: {
          agent_id: "codex",
          memory_id: proposedMemory.id
        }
      }
    }, { authorization: "Bearer agent-token" });

    assert.match(approve.json.error.message, /requires admin authorization/);
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("HTTP service refuses non-local binds without an auth token", async () => {
  const dataDir = makeTempDir();
  const child = spawn(process.execPath, ["--no-warnings", "src/dashboard.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      LIBRARIAN_DATA_DIR: dataDir,
      LIBRARIAN_HOST: "0.0.0.0",
      LIBRARIAN_PORT: "0",
      LIBRARIAN_AUTH_TOKEN: ""
    },
    stdio: ["ignore", "ignore", "pipe"]
  });

  try {
    const { code, stderr } = await waitForExit(child);
    assert.equal(code, 1);
    assert.match(stderr, /Refusing to start without LIBRARIAN_ADMIN_TOKEN or LIBRARIAN_AUTH_TOKEN/);
  } finally {
    cleanupTempDir(dataDir);
  }
});

test("HTTP service refuses identical admin and agent tokens", async () => {
  const dataDir = makeTempDir();
  const child = spawn(process.execPath, ["--no-warnings", "src/dashboard.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      LIBRARIAN_DATA_DIR: dataDir,
      LIBRARIAN_HOST: "127.0.0.1",
      LIBRARIAN_PORT: "0",
      LIBRARIAN_AUTH_TOKEN: "same-token",
      LIBRARIAN_AGENT_TOKEN: "same-token"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });

  try {
    const { code, stderr } = await waitForExit(child);
    assert.equal(code, 1);
    assert.match(stderr, /must be different/);
  } finally {
    cleanupTempDir(dataDir);
  }
});

function waitForExit(child) {
  return new Promise((resolve) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
}
