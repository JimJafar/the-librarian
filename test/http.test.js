import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  cleanupTempDir,
  makeTempDir,
  postJson,
  startHttpServer,
} from "./helpers.js";

test("HTTP service exposes dashboard/API without auth and protects MCP with auth", async () => {
  const dataDir = makeTempDir();
  const server = await startHttpServer({
    dataDir,
    token: "http-token",
    agentToken: "http-agent-token",
  });
  try {
    const health = await fetch(`${server.url}/healthz`);
    assert.equal(health.status, 200);
    const healthJson = await health.json();
    assert.equal(healthJson.auth, "enabled");
    assert.equal(healthJson.dashboard_auth, "disabled");
    assert.equal(healthJson.mcp_auth, "enabled");
    assert.equal(healthJson.agent_auth, "enabled");
    assert.equal("data_dir" in healthJson, false);

    const dashboard = await fetch(`${server.url}/`);
    assert.equal(dashboard.status, 200);
    const dashboardHtml = await dashboard.text();
    assert.match(dashboardHtml, /The Librarian/);
    assert.match(dashboardHtml, /\/styles\.css/);
    assert.match(dashboardHtml, /\/app\.js/);
    assert.match(dashboardHtml, /identity \(protected\)/);
    assert.match(dashboardHtml, /id="toast"/);

    const dashboardScript = await fetch(`${server.url}/app.js`);
    assert.equal(dashboardScript.status, 200);
    const dashboardScriptText = await dashboardScript.text();
    assert.match(dashboardScriptText, /editAgent/);
    assert.match(dashboardScriptText, /editTags/);
    assert.match(dashboardScriptText, /editScope/);
    assert.match(dashboardScriptText, /editCategory/);
    assert.match(dashboardScriptText, /showToast/);
    assert.match(dashboardScriptText, /PROTECTED_CATEGORIES/);

    const dashboardStyles = await fetch(`${server.url}/styles.css`);
    assert.equal(dashboardStyles.status, 200);
    assert.match(await dashboardStyles.text(), /editor-grid/);

    const apiState = await fetch(`${server.url}/api/state`);
    assert.equal(apiState.status, 200);

    const unauthMcp = await postJson(`${server.url}/mcp`, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    assert.equal(unauthMcp.response.status, 401);

    const authMcp = await postJson(
      `${server.url}/mcp`,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      },
      { authorization: "Bearer http-agent-token" },
    );
    assert.equal(authMcp.response.status, 200);
    assert.equal(authMcp.json.result.serverInfo.name, "the-librarian");

    const agentApi = await fetch(`${server.url}/api/state`, {
      headers: { authorization: "Bearer http-agent-token" },
    });
    assert.equal(agentApi.status, 200);
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
    allowedOrigins: "http://trusted.local",
  });
  try {
    const rejected = await postJson(
      `${server.url}/mcp`,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      },
      {
        authorization: "Bearer agent-token",
        origin: "http://evil.local",
      },
    );
    assert.equal(rejected.response.status, 403);

    const accepted = await postJson(
      `${server.url}/mcp`,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {},
      },
      {
        authorization: "Bearer agent-token",
        origin: "http://trusted.local",
      },
    );
    assert.equal(accepted.response.status, 200);
    assert.equal(accepted.json.result.serverInfo.name, "the-librarian");
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("HTTP rejects browser origins by default unless they are same-origin", async () => {
  const dataDir = makeTempDir();
  const server = await startHttpServer({
    dataDir,
    token: "origin-default-token",
    agentToken: "origin-default-agent-token",
  });
  try {
    const rejected = await postJson(
      `${server.url}/mcp`,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      },
      {
        authorization: "Bearer origin-default-agent-token",
        origin: "http://evil.local",
      },
    );
    assert.equal(rejected.response.status, 403);

    const accepted = await postJson(
      `${server.url}/mcp`,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {},
      },
      {
        authorization: "Bearer origin-default-agent-token",
        origin: server.url,
      },
    );
    assert.equal(accepted.response.status, 200);

    const rejectedDashboardPost = await postJson(
      `${server.url}/api/memories`,
      {
        agent_id: "dashboard",
        title: "Blocked cross-origin dashboard write",
        body: "An untrusted browser origin should not write through the open dashboard API.",
        category: "tools",
        visibility: "common",
        scope: "tool",
      },
      {
        origin: "http://evil.local",
      },
    );
    assert.equal(rejectedDashboardPost.response.status, 403);

    const acceptedDashboardPost = await postJson(
      `${server.url}/api/memories`,
      {
        agent_id: "dashboard",
        title: "Accepted same-origin dashboard write",
        body: "A same-origin dashboard request can write without an auth token.",
        category: "tools",
        visibility: "common",
        scope: "tool",
      },
      {
        origin: server.url,
      },
    );
    assert.equal(acceptedDashboardPost.response.status, 200);
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("HTTP dashboard can create proposals, approve them, and recall through MCP", async () => {
  const dataDir = makeTempDir();
  const server = await startHttpServer({
    dataDir,
    token: "workflow-token",
    agentToken: "workflow-agent-token",
  });
  try {
    const create = await postJson(`${server.url}/api/memories`, {
      agent_id: "dashboard",
      title: "Identity proposal through dashboard",
      body: "Protected identity memories created through the dashboard start as proposals.",
      category: "identity",
      visibility: "common",
      scope: "global",
      priority: "core",
    });

    assert.equal(create.response.status, 200);
    assert.equal(create.json.status, "proposed");

    const approve = await postJson(
      `${server.url}/api/proposals/${create.json.memory.id}/approve`,
      {
        agent_id: "dashboard",
      },
    );
    assert.equal(approve.response.status, 200);
    assert.equal(approve.json.status, "active");

    const context = await postJson(
      `${server.url}/mcp`,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "start_context",
          arguments: {
            agent_id: "codex",
            task_summary: "test dashboard proposal approval",
          },
        },
      },
      { authorization: "Bearer workflow-token" },
    );

    assert.equal(context.response.status, 200);
    assert.match(
      context.json.result.content[0].text,
      /Protected identity memories/,
    );
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("HTTP dashboard can edit active protected memories as the admin surface", async () => {
  const dataDir = makeTempDir();
  const server = await startHttpServer({ dataDir, token: "protected-edit-token", agentToken: "protected-edit-agent-token" });
  try {
    const create = await postJson(`${server.url}/api/memories`, {
      agent_id: "dashboard",
      title: "Protected relationship memory",
      body: "Protected memories start in the proposal queue.",
      category: "relationship",
      visibility: "common",
      scope: "global",
      priority: "core",
      tags: ["relationship"]
    });
    assert.equal(create.response.status, 200);
    assert.equal(create.json.status, "proposed");

    const approve = await postJson(`${server.url}/api/proposals/${create.json.memory.id}/approve`, {
      agent_id: "dashboard"
    });
    assert.equal(approve.response.status, 200);
    assert.equal(approve.json.status, "active");

    const update = await postJson(`${server.url}/api/memories/${create.json.memory.id}/update`, {
      agent_id: "dashboard",
      patch: {
        body: "Dashboard edits can directly refine active protected memories.",
        tags: ["relationship", "dashboard-edit"]
      }
    });
    assert.equal(update.response.status, 200);
    assert.equal(update.json.status, "active");
    assert.equal(update.json.category, "relationship");
    assert.equal(update.json.body, "Dashboard edits can directly refine active protected memories.");
    assert.deepEqual(update.json.tags, ["relationship", "dashboard-edit"]);
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("HTTP dashboard API can update ordinary memory routing fields", async () => {
  const dataDir = makeTempDir();
  const server = await startHttpServer({
    dataDir,
    token: "edit-token",
    agentToken: "edit-agent-token",
  });
  try {
    const create = await postJson(`${server.url}/api/memories`, {
      agent_id: "dashboard",
      title: "Editable dashboard memory",
      body: "The dashboard should expose routing fields for ordinary memories.",
      category: "tools",
      visibility: "common",
      scope: "tool",
      project_key: "the-librarian",
      tags: ["dashboard"],
    });

    assert.equal(create.response.status, 200);
    assert.equal(create.json.status, "active");

    const update = await postJson(
      `${server.url}/api/memories/${create.json.memory.id}/update`,
      {
        agent_id: "dashboard",
        patch: {
          agent_id: "codex",
          category: "projects",
          visibility: "agent_private",
          scope: "project",
          project_key: "memory-system",
          tags: ["dashboard", "editing", "routing"],
        },
      },
    );

    assert.equal(update.response.status, 200);
    assert.equal(update.json.agent_id, "codex");
    assert.equal(update.json.category, "projects");
    assert.equal(update.json.visibility, "agent_private");
    assert.equal(update.json.scope, "project");
    assert.equal(update.json.project_key, "memory-system");
    assert.deepEqual(update.json.tags, ["dashboard", "editing", "routing"]);
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("HTTP dashboard API is open but cannot force protected memories active", async () => {
  const dataDir = makeTempDir();
  const server = await startHttpServer({
    dataDir,
    token: "admin-token",
    agentToken: "agent-token",
  });
  try {
    const dashboardCreate = await postJson(`${server.url}/api/memories`, {
      agent_id: "codex",
      title: "Bypass attempt",
      body: "Dashboard clients should not be able to force protected memories active.",
      category: "identity",
      visibility: "common",
      scope: "global",
      force_active: true,
    });

    assert.equal(dashboardCreate.response.status, 200);
    assert.equal(dashboardCreate.json.status, "proposed");

    const proposal = await postJson(
      `${server.url}/mcp`,
      {
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
            scope: "global",
          },
        },
      },
      { authorization: "Bearer agent-token" },
    );

    assert.equal(proposal.response.status, 200);
    assert.match(proposal.json.result.content[0].text, /proposal for review/);

    const proposals = await fetch(`${server.url}/api/state`);
    const proposedMemory = (await proposals.json()).memories.find(
      (memory) => memory.title === "Agent proposal",
    );
    assert.equal(proposedMemory.status, "proposed");

    const approve = await postJson(
      `${server.url}/mcp`,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "approve_proposal",
          arguments: {
            agent_id: "codex",
            memory_id: proposedMemory.id,
          },
        },
      },
      { authorization: "Bearer agent-token" },
    );

    assert.match(approve.json.error.message, /requires admin authorization/);
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("HTTP per-agent bearer tokens prevent agent_id impersonation", async () => {
  const dataDir = makeTempDir();
  const server = await startHttpServer({
    dataDir,
    token: "mapped-admin-token",
    agentToken: "",
    agentTokens: "codex:codex-token,claude:claude-token",
  });
  try {
    await postJson(`${server.url}/api/memories`, {
      agent_id: "dashboard",
      title: "Shared tool note",
      body: "Common memory should be visible to mapped agents.",
      category: "tools",
      visibility: "common",
      scope: "tool",
    });
    await postJson(`${server.url}/api/memories`, {
      agent_id: "codex",
      title: "Codex private note",
      body: "Codex private memory should follow the Codex token.",
      category: "tools",
      visibility: "agent_private",
      scope: "tool",
    });
    await postJson(`${server.url}/api/memories`, {
      agent_id: "claude",
      title: "Claude private note",
      body: "Claude private memory must not leak to the Codex token.",
      category: "tools",
      visibility: "agent_private",
      scope: "tool",
    });

    const recall = await postJson(
      `${server.url}/mcp`,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "recall",
          arguments: {
            agent_id: "claude",
            query: "private memory",
            include_private: true,
            limit: 10,
          },
        },
      },
      { authorization: "Bearer codex-token" },
    );

    assert.equal(recall.response.status, 200);
    const text = recall.json.result.content[0].text;
    assert.match(text, /Codex private memory/);
    assert.doesNotMatch(text, /Claude private memory/);

    const remember = await postJson(
      `${server.url}/mcp`,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "remember",
          arguments: {
            agent_id: "claude",
            title: "Spoofed writer",
            body: "This should be attributed to the authenticated Codex agent.",
            category: "tools",
            visibility: "agent_private",
            scope: "tool",
          },
        },
      },
      { authorization: "Bearer codex-token" },
    );
    assert.equal(remember.response.status, 200);

    const state = await fetch(`${server.url}/api/state`);
    const saved = (await state.json()).memories.find(
      (memory) => memory.title === "Spoofed writer",
    );
    assert.equal(saved.agent_id, "codex");
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("HTTP returns client errors for malformed and oversized JSON bodies", async () => {
  const dataDir = makeTempDir();
  const server = await startHttpServer({
    dataDir,
    token: "body-token",
    agentToken: "body-agent-token",
  });
  try {
    const malformed = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer body-agent-token",
        "content-type": "application/json",
      },
      body: "{",
    });
    assert.equal(malformed.status, 400);

    const oversized = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer body-agent-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ padding: "x".repeat(1024 * 1024 + 1) }),
    });
    assert.equal(oversized.status, 413);
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
      LIBRARIAN_ALLOW_NO_AUTH: "",
      LIBRARIAN_ADMIN_TOKEN: "",
      LIBRARIAN_AUTH_TOKEN: "",
      LIBRARIAN_AGENT_TOKEN: "",
      LIBRARIAN_AGENT_TOKENS: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  try {
    const { code, stderr } = await waitForExit(child);
    assert.equal(code, 1);
    assert.match(
      stderr,
      /Refusing to start without LIBRARIAN_ADMIN_TOKEN or LIBRARIAN_AUTH_TOKEN/,
    );
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
      LIBRARIAN_HOST: "0.0.0.0",
      LIBRARIAN_PORT: "0",
      LIBRARIAN_ALLOW_NO_AUTH: "",
      LIBRARIAN_ADMIN_TOKEN: "same-token",
      LIBRARIAN_AUTH_TOKEN: "",
      LIBRARIAN_AGENT_TOKEN: "same-token",
      LIBRARIAN_AGENT_TOKENS: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
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
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve({ code: child.exitCode, signal: child.signalCode, stderr });
    }, 2000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
}
