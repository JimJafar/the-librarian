import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cleanupTempDir, makeTempDir, postJson, startHttpServer } from "../../../test/helpers.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HTTP_BIN = path.join(REPO_ROOT, "packages", "mcp-server", "src", "bin", "http.js");

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
    assert.match(dashboardHtml, /id="eventControls"/);

    const dashboardScript = await fetch(`${server.url}/app.js`);
    assert.equal(dashboardScript.status, 200);
    const dashboardScriptText = await dashboardScript.text();
    assert.match(dashboardScriptText, /editAgent/);
    assert.match(dashboardScriptText, /editTags/);
    assert.match(dashboardScriptText, /editScope/);
    assert.match(dashboardScriptText, /editCategory/);
    assert.match(dashboardScriptText, /showToast/);
    assert.match(dashboardScriptText, /PROTECTED_CATEGORIES/);
    assert.match(dashboardScriptText, /loadEvents/);

    const dashboardStyles = await fetch(`${server.url}/styles.css`);
    assert.equal(dashboardStyles.status, 200);
    const dashboardStylesText = await dashboardStyles.text();
    assert.match(dashboardStylesText, /editor-grid/);
    assert.match(dashboardStylesText, /event-controls/);

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

    const approve = await postJson(`${server.url}/api/proposals/${create.json.memory.id}/approve`, {
      agent_id: "dashboard",
    });
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
    assert.match(context.json.result.content[0].text, /Protected identity memories/);
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("HTTP dashboard can edit active protected memories as the admin surface", async () => {
  const dataDir = makeTempDir();
  const server = await startHttpServer({
    dataDir,
    token: "protected-edit-token",
    agentToken: "protected-edit-agent-token",
  });
  try {
    const create = await postJson(`${server.url}/api/memories`, {
      agent_id: "dashboard",
      title: "Protected relationship memory",
      body: "Protected memories start in the proposal queue.",
      category: "relationship",
      visibility: "common",
      scope: "global",
      priority: "core",
      tags: ["relationship"],
    });
    assert.equal(create.response.status, 200);
    assert.equal(create.json.status, "proposed");

    const approve = await postJson(`${server.url}/api/proposals/${create.json.memory.id}/approve`, {
      agent_id: "dashboard",
    });
    assert.equal(approve.response.status, 200);
    assert.equal(approve.json.status, "active");

    const update = await postJson(`${server.url}/api/memories/${create.json.memory.id}/update`, {
      agent_id: "dashboard",
      patch: {
        body: "Dashboard edits can directly refine active protected memories.",
        tags: ["relationship", "dashboard-edit"],
      },
    });
    assert.equal(update.response.status, 200);
    assert.equal(update.json.status, "active");
    assert.equal(update.json.category, "relationship");
    assert.equal(
      update.json.body,
      "Dashboard edits can directly refine active protected memories.",
    );
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

    const update = await postJson(`${server.url}/api/memories/${create.json.memory.id}/update`, {
      agent_id: "dashboard",
      patch: {
        agent_id: "codex",
        category: "projects",
        visibility: "agent_private",
        scope: "project",
        project_key: "memory-system",
        tags: ["dashboard", "editing", "routing"],
      },
    });

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

test("HTTP event log is paginated, filterable, and records empty or unhelpful recall", async () => {
  const dataDir = makeTempDir();
  const server = await startHttpServer({
    dataDir,
    token: "events-token",
    agentToken: "events-agent-token",
  });
  try {
    const emptyRecall = await postJson(`${server.url}/api/recall`, {
      agent_id: "codex",
      query: "definitely no memories match this",
      limit: 5,
    });
    assert.equal(emptyRecall.response.status, 200);
    assert.deepEqual(emptyRecall.json.memories, []);

    const emptyEvents = await fetch(
      `${server.url}/api/events?type=memory.recall_empty&agent_id=codex&limit=2&offset=0`,
    );
    assert.equal(emptyEvents.status, 200);
    const emptyJson = await emptyEvents.json();
    assert.equal(emptyJson.total, 1);
    assert.equal(emptyJson.limit, 2);
    assert.equal(emptyJson.offset, 0);
    assert.equal(emptyJson.events[0].event_type, "memory.recall_empty");
    assert.equal(emptyJson.events[0].payload.query, "definitely no memories match this");
    assert.equal(emptyJson.events[0].payload.returned_count, 0);

    const create = await postJson(`${server.url}/api/memories`, {
      agent_id: "dashboard",
      title: "Bad recall candidate",
      body: "This memory will be marked not useful and wrong.",
      category: "tools",
      visibility: "common",
      scope: "tool",
    });
    assert.equal(create.response.status, 200);

    for (const result of ["not_useful", "wrong"]) {
      const verification = await postJson(
        `${server.url}/mcp`,
        {
          jsonrpc: "2.0",
          id: result,
          method: "tools/call",
          params: {
            name: "verify_memory",
            arguments: {
              agent_id: "codex",
              memory_id: create.json.memory.id,
              result,
              note: `${result} recall feedback`,
            },
          },
        },
        { authorization: "Bearer events-agent-token" },
      );
      assert.equal(verification.response.status, 200);
    }

    const wrongEvents = await fetch(
      `${server.url}/api/events?type=memory.verified&result=wrong&query=wrong%20recall&limit=1`,
    );
    assert.equal(wrongEvents.status, 200);
    const wrongJson = await wrongEvents.json();
    assert.equal(wrongJson.total, 1);
    assert.equal(wrongJson.events[0].payload.result, "wrong");
    assert.equal(wrongJson.events[0].payload.note, "wrong recall feedback");

    const notUsefulEvents = await fetch(
      `${server.url}/api/events?type=memory.verified&result=not_useful&limit=1`,
    );
    assert.equal(notUsefulEvents.status, 200);
    const notUsefulJson = await notUsefulEvents.json();
    assert.equal(notUsefulJson.total, 1);
    assert.equal(notUsefulJson.events[0].payload.result, "not_useful");
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
    const saved = (await state.json()).memories.find((memory) => memory.title === "Spoofed writer");
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
  const child = spawn(process.execPath, ["--no-warnings", HTTP_BIN], {
    cwd: REPO_ROOT,
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
    assert.match(stderr, /Refusing to start without LIBRARIAN_ADMIN_TOKEN or LIBRARIAN_AUTH_TOKEN/);
  } finally {
    cleanupTempDir(dataDir);
  }
});

test("HTTP service refuses identical admin and agent tokens", async () => {
  const dataDir = makeTempDir();
  const child = spawn(process.execPath, ["--no-warnings", HTTP_BIN], {
    cwd: REPO_ROOT,
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

test("GET /api/aggregates returns dimension counts", async () => {
  const dataDir = makeTempDir();
  const server = await startHttpServer({ dataDir });
  try {
    await postJson(`${server.url}/api/memories`, {
      agent_id: "codex",
      title: "Codex memory one",
      body: "Body text one",
      category: "tools",
      visibility: "agent_private",
      scope: "tool",
    });
    await postJson(`${server.url}/api/memories`, {
      agent_id: "codex",
      title: "Codex memory two",
      body: "Body text two",
      category: "tools",
      visibility: "agent_private",
      scope: "tool",
    });
    await postJson(`${server.url}/api/memories`, {
      agent_id: "claude",
      title: "Claude memory one",
      body: "Body text three",
      category: "tools",
      visibility: "agent_private",
      scope: "tool",
    });

    const res = await fetch(`${server.url}/api/aggregates`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.agents[0].value, "codex");
    assert.equal(body.agents[0].count, 2);
    assert.equal(body.agents[1].value, "claude");
    assert.equal(body.agents[1].count, 1);
    assert.equal(body.total, 3);
    assert.ok(Array.isArray(body.categories));
    assert.ok(body.categories.length > 0);
    assert.ok("value" in body.categories[0] && "count" in body.categories[0]);
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("GET /api/aggregates excludes deleted memories", async () => {
  const dataDir = makeTempDir();
  const server = await startHttpServer({ dataDir });
  try {
    const create = await postJson(`${server.url}/api/memories`, {
      agent_id: "codex",
      title: "Memory to delete",
      body: "Will be deleted",
      category: "tools",
      visibility: "common",
      scope: "tool",
    });
    assert.equal(create.json.status, "active");
    await postJson(`${server.url}/api/memories/${create.json.memory.id}/delete`, {
      agent_id: "dashboard",
    });

    const res = await fetch(`${server.url}/api/aggregates`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 0);
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("GET /api/memories/:id/related returns similarity data", async () => {
  const dataDir = makeTempDir();
  const server = await startHttpServer({ dataDir });
  try {
    const create1 = await postJson(`${server.url}/api/memories`, {
      agent_id: "similarity_agent",
      title: "database configuration settings guide",
      body: "configure database settings for production deployment",
      category: "tools",
      visibility: "common",
      scope: "tool",
    });
    assert.equal(create1.json.status, "active");

    await postJson(`${server.url}/api/memories`, {
      agent_id: "similarity_agent",
      title: "database configuration settings guide",
      body: "configure database settings for staging deployment",
      category: "tools",
      visibility: "common",
      scope: "tool",
    });

    const res = await fetch(`${server.url}/api/memories/${create1.json.memory.id}/related`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.memory.id, create1.json.memory.id);
    assert.ok(body.related.length >= 1);
    assert.ok(typeof body.related[0].ratio === "number");
    assert.ok(body.related[0].ratio >= 0 && body.related[0].ratio <= 1);
    assert.ok(typeof body.related[0].isDuplicate === "boolean");
    assert.ok(typeof body.related[0].isConflict === "boolean");
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("GET /api/memories/:id/related returns 404 for unknown id", async () => {
  const dataDir = makeTempDir();
  const server = await startHttpServer({ dataDir });
  try {
    const res = await fetch(`${server.url}/api/memories/mem_doesnotexist/related`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "Not found");
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("GET /api/memories with date range filtering", async () => {
  const dataDir = makeTempDir();
  const server = await startHttpServer({ dataDir });
  try {
    await postJson(`${server.url}/api/memories`, {
      title: "Memory A before filter",
      body: "Created before the filter",
      category: "tools",
      visibility: "common",
      scope: "tool",
    });

    await new Promise((r) => setTimeout(r, 5));
    const T2 = new Date().toISOString();

    const createB = await postJson(`${server.url}/api/memories`, {
      title: "Memory B after filter",
      body: "Created after the filter",
      category: "tools",
      visibility: "common",
      scope: "tool",
    });
    assert.equal(createB.json.status, "active");

    const res = await fetch(`${server.url}/api/memories?from=${encodeURIComponent(T2)}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 1);
    assert.equal(body.memories.length, 1);
    assert.equal(body.memories[0].id, createB.json.memory.id);
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("GET /api/memories with sort and pagination", async () => {
  const dataDir = makeTempDir();
  const server = await startHttpServer({ dataDir });
  try {
    await postJson(`${server.url}/api/memories`, {
      title: "Banana memory",
      body: "Second alphabetically",
      category: "tools",
      visibility: "common",
      scope: "tool",
    });
    await postJson(`${server.url}/api/memories`, {
      title: "Apple memory",
      body: "First alphabetically",
      category: "tools",
      visibility: "common",
      scope: "tool",
    });
    await postJson(`${server.url}/api/memories`, {
      title: "Cherry memory",
      body: "Third alphabetically",
      category: "tools",
      visibility: "common",
      scope: "tool",
    });

    const page1 = await fetch(`${server.url}/api/memories?sort=title&order=asc&limit=2&offset=0`);
    assert.equal(page1.status, 200);
    const page1Json = await page1.json();
    assert.equal(page1Json.memories.length, 2);
    assert.equal(page1Json.total, 3);
    assert.equal(page1Json.memories[0].title, "Apple memory");
    assert.equal(page1Json.memories[1].title, "Banana memory");

    const page2 = await fetch(`${server.url}/api/memories?sort=title&order=asc&limit=2&offset=2`);
    assert.equal(page2.status, 200);
    const page2Json = await page2.json();
    assert.equal(page2Json.memories.length, 1);
    assert.equal(page2Json.total, 3);
    assert.equal(page2Json.memories[0].title, "Cherry memory");
  } finally {
    await server.stop();
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
