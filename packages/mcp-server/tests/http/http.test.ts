// HTTP integration tests.
//
// Migrated from packages/mcp-server/tests/http.test.js as part of T4.1.
// Behaviour coverage is identical to the pre-migration suite — these
// tests spawn the compiled bin (`dist/bin/http.js`) and exercise the
// HTTP surface end-to-end (dashboard, /mcp, /api/*, boot-time auth
// validation, body limits).

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  makeTempDir,
  postJson,
  startHttpServer,
} from "../../../../test/helpers.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const HTTP_BIN = path.join(REPO_ROOT, "packages", "mcp-server", "dist", "bin", "http.js");

describe("HTTP service", () => {
  it("exposes dashboard/API without auth and protects MCP with auth", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({
      dataDir,
      token: "http-token",
      agentToken: "http-agent-token",
    });
    try {
      const health = await fetch(`${server.url}/healthz`);
      expect(health.status).toBe(200);
      const healthJson = (await health.json()) as Record<string, unknown>;
      expect(healthJson.auth).toBe("enabled");
      expect(healthJson.dashboard_auth).toBe("disabled");
      expect(healthJson.mcp_auth).toBe("enabled");
      expect(healthJson.agent_auth).toBe("enabled");
      expect("data_dir" in healthJson).toBe(false);

      const dashboard = await fetch(`${server.url}/`);
      expect(dashboard.status).toBe(200);
      const dashboardHtml = await dashboard.text();
      expect(dashboardHtml).toMatch(/The Librarian/);
      expect(dashboardHtml).toMatch(/\/styles\.css/);
      expect(dashboardHtml).toMatch(/\/app\.js/);
      expect(dashboardHtml).toMatch(/identity \(protected\)/);
      expect(dashboardHtml).toMatch(/id="toast"/);
      expect(dashboardHtml).toMatch(/id="eventControls"/);

      const dashboardScript = await fetch(`${server.url}/app.js`);
      expect(dashboardScript.status).toBe(200);
      const dashboardScriptText = await dashboardScript.text();
      expect(dashboardScriptText).toMatch(/editAgent/);
      expect(dashboardScriptText).toMatch(/editTags/);
      expect(dashboardScriptText).toMatch(/editScope/);
      expect(dashboardScriptText).toMatch(/editCategory/);
      expect(dashboardScriptText).toMatch(/showToast/);
      expect(dashboardScriptText).toMatch(/PROTECTED_CATEGORIES/);
      expect(dashboardScriptText).toMatch(/loadEvents/);

      const dashboardStyles = await fetch(`${server.url}/styles.css`);
      expect(dashboardStyles.status).toBe(200);
      const dashboardStylesText = await dashboardStyles.text();
      expect(dashboardStylesText).toMatch(/editor-grid/);
      expect(dashboardStylesText).toMatch(/event-controls/);

      const apiState = await fetch(`${server.url}/api/state`);
      expect(apiState.status).toBe(200);

      const unauthMcp = await postJson(`${server.url}/mcp`, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });
      expect(unauthMcp.response.status).toBe(401);

      const authMcp = await postJson(
        `${server.url}/mcp`,
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { authorization: "Bearer http-agent-token" },
      );
      expect(authMcp.response.status).toBe(200);
      expect(authMcp.json.result.serverInfo.name).toBe("the-librarian");

      const agentApi = await fetch(`${server.url}/api/state`, {
        headers: { authorization: "Bearer http-agent-token" },
      });
      expect(agentApi.status).toBe(200);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("Origin allow-list rejects untrusted browser origins", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({
      dataDir,
      token: "origin-token",
      allowedOrigins: "http://trusted.local",
    });
    try {
      const rejected = await postJson(
        `${server.url}/mcp`,
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { authorization: "Bearer agent-token", origin: "http://evil.local" },
      );
      expect(rejected.response.status).toBe(403);

      const accepted = await postJson(
        `${server.url}/mcp`,
        { jsonrpc: "2.0", id: 2, method: "initialize", params: {} },
        { authorization: "Bearer agent-token", origin: "http://trusted.local" },
      );
      expect(accepted.response.status).toBe(200);
      expect(accepted.json.result.serverInfo.name).toBe("the-librarian");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("rejects browser origins by default unless they are same-origin", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({
      dataDir,
      token: "origin-default-token",
      agentToken: "origin-default-agent-token",
    });
    try {
      const rejected = await postJson(
        `${server.url}/mcp`,
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        {
          authorization: "Bearer origin-default-agent-token",
          origin: "http://evil.local",
        },
      );
      expect(rejected.response.status).toBe(403);

      const accepted = await postJson(
        `${server.url}/mcp`,
        { jsonrpc: "2.0", id: 2, method: "initialize", params: {} },
        { authorization: "Bearer origin-default-agent-token", origin: server.url },
      );
      expect(accepted.response.status).toBe(200);

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
        { origin: "http://evil.local" },
      );
      expect(rejectedDashboardPost.response.status).toBe(403);

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
        { origin: server.url },
      );
      expect(acceptedDashboardPost.response.status).toBe(200);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("dashboard can create proposals, approve them, and recall through MCP", async () => {
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

      expect(create.response.status).toBe(200);
      expect(create.json.status).toBe("proposed");

      const approve = await postJson(
        `${server.url}/api/proposals/${create.json.memory.id}/approve`,
        { agent_id: "dashboard" },
      );
      expect(approve.response.status).toBe(200);
      expect(approve.json.status).toBe("active");

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

      expect(context.response.status).toBe(200);
      expect(context.json.result.content[0].text).toMatch(/Protected identity memories/);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("dashboard can edit active protected memories as the admin surface", async () => {
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
      expect(create.response.status).toBe(200);
      expect(create.json.status).toBe("proposed");

      const approve = await postJson(
        `${server.url}/api/proposals/${create.json.memory.id}/approve`,
        { agent_id: "dashboard" },
      );
      expect(approve.response.status).toBe(200);
      expect(approve.json.status).toBe("active");

      const update = await postJson(`${server.url}/api/memories/${create.json.memory.id}/update`, {
        agent_id: "dashboard",
        patch: {
          body: "Dashboard edits can directly refine active protected memories.",
          tags: ["relationship", "dashboard-edit"],
        },
      });
      expect(update.response.status).toBe(200);
      expect(update.json.status).toBe("active");
      expect(update.json.category).toBe("relationship");
      expect(update.json.body).toBe(
        "Dashboard edits can directly refine active protected memories.",
      );
      expect(update.json.tags).toEqual(["relationship", "dashboard-edit"]);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("dashboard API can update ordinary memory routing fields", async () => {
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

      expect(create.response.status).toBe(200);
      expect(create.json.status).toBe("active");

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

      expect(update.response.status).toBe(200);
      expect(update.json.agent_id).toBe("codex");
      expect(update.json.category).toBe("projects");
      expect(update.json.visibility).toBe("agent_private");
      expect(update.json.scope).toBe("project");
      expect(update.json.project_key).toBe("memory-system");
      expect(update.json.tags).toEqual(["dashboard", "editing", "routing"]);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("event log is paginated, filterable, and records empty or unhelpful recall", async () => {
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
      expect(emptyRecall.response.status).toBe(200);
      expect(emptyRecall.json.memories).toEqual([]);

      const emptyEvents = await fetch(
        `${server.url}/api/events?type=memory.recall_empty&agent_id=codex&limit=2&offset=0`,
      );
      expect(emptyEvents.status).toBe(200);
      const emptyJson = (await emptyEvents.json()) as Record<string, unknown> & {
        events: { event_type: string; payload: Record<string, unknown> }[];
      };
      expect(emptyJson.total).toBe(1);
      expect(emptyJson.limit).toBe(2);
      expect(emptyJson.offset).toBe(0);
      expect(emptyJson.events[0].event_type).toBe("memory.recall_empty");
      expect(emptyJson.events[0].payload.query).toBe("definitely no memories match this");
      expect(emptyJson.events[0].payload.returned_count).toBe(0);

      const create = await postJson(`${server.url}/api/memories`, {
        agent_id: "dashboard",
        title: "Bad recall candidate",
        body: "This memory will be marked not useful and wrong.",
        category: "tools",
        visibility: "common",
        scope: "tool",
      });
      expect(create.response.status).toBe(200);

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
        expect(verification.response.status).toBe(200);
      }

      const wrongEvents = await fetch(
        `${server.url}/api/events?type=memory.verified&result=wrong&query=wrong%20recall&limit=1`,
      );
      expect(wrongEvents.status).toBe(200);
      const wrongJson = (await wrongEvents.json()) as Record<string, unknown> & {
        events: { payload: Record<string, unknown> }[];
      };
      expect(wrongJson.total).toBe(1);
      expect(wrongJson.events[0].payload.result).toBe("wrong");
      expect(wrongJson.events[0].payload.note).toBe("wrong recall feedback");

      const notUsefulEvents = await fetch(
        `${server.url}/api/events?type=memory.verified&result=not_useful&limit=1`,
      );
      expect(notUsefulEvents.status).toBe(200);
      const notUsefulJson = (await notUsefulEvents.json()) as Record<string, unknown> & {
        events: { payload: Record<string, unknown> }[];
      };
      expect(notUsefulJson.total).toBe(1);
      expect(notUsefulJson.events[0].payload.result).toBe("not_useful");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("dashboard API is open but cannot force protected memories active", async () => {
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

      expect(dashboardCreate.response.status).toBe(200);
      expect(dashboardCreate.json.status).toBe("proposed");

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

      expect(proposal.response.status).toBe(200);
      expect(proposal.json.result.content[0].text).toMatch(/proposal for review/);

      const proposals = await fetch(`${server.url}/api/state`);
      const proposedMemory = (
        (await proposals.json()) as { memories: Record<string, unknown>[] }
      ).memories.find((memory) => memory.title === "Agent proposal") as Record<string, unknown>;
      expect(proposedMemory.status).toBe("proposed");

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

      expect(approve.json.error.message).toMatch(/requires admin authorization/);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("per-agent bearer tokens prevent agent_id impersonation", async () => {
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

      expect(recall.response.status).toBe(200);
      const text = recall.json.result.content[0].text;
      expect(text).toMatch(/Codex private memory/);
      expect(text).not.toMatch(/Claude private memory/);

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
      expect(remember.response.status).toBe(200);

      const state = await fetch(`${server.url}/api/state`);
      const saved = ((await state.json()) as { memories: Record<string, unknown>[] }).memories.find(
        (memory) => memory.title === "Spoofed writer",
      ) as Record<string, unknown>;
      expect(saved.agent_id).toBe("codex");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("returns client errors for malformed and oversized JSON bodies", async () => {
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
      expect(malformed.status).toBe(400);

      const oversized = await fetch(`${server.url}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer body-agent-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ padding: "x".repeat(1024 * 1024 + 1) }),
      });
      expect(oversized.status).toBe(413);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("refuses non-local binds without an auth token", async () => {
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
      expect(code).toBe(1);
      expect(stderr).toMatch(
        /Refusing to start without LIBRARIAN_ADMIN_TOKEN or LIBRARIAN_AUTH_TOKEN/,
      );
    } finally {
      cleanupTempDir(dataDir);
    }
  });

  it("refuses identical admin and agent tokens", async () => {
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
      expect(code).toBe(1);
      expect(stderr).toMatch(/must be different/);
    } finally {
      cleanupTempDir(dataDir);
    }
  });
});

describe("GET /api/aggregates", () => {
  it("returns dimension counts", async () => {
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
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        agents: { value: string; count: number }[];
        categories: { value: string; count: number }[];
        total: number;
      };
      expect(body.agents[0].value).toBe("codex");
      expect(body.agents[0].count).toBe(2);
      expect(body.agents[1].value).toBe("claude");
      expect(body.agents[1].count).toBe(1);
      expect(body.total).toBe(3);
      expect(Array.isArray(body.categories)).toBe(true);
      expect(body.categories.length).toBeGreaterThan(0);
      expect("value" in body.categories[0] && "count" in body.categories[0]).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("excludes deleted memories", async () => {
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
      expect(create.json.status).toBe("active");
      await postJson(`${server.url}/api/memories/${create.json.memory.id}/delete`, {
        agent_id: "dashboard",
      });

      const res = await fetch(`${server.url}/api/aggregates`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { total: number };
      expect(body.total).toBe(0);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});

describe("GET /api/memories/:id/related", () => {
  it("returns similarity data", async () => {
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
      expect(create1.json.status).toBe("active");

      await postJson(`${server.url}/api/memories`, {
        agent_id: "similarity_agent",
        title: "database configuration settings guide",
        body: "configure database settings for staging deployment",
        category: "tools",
        visibility: "common",
        scope: "tool",
      });

      const res = await fetch(`${server.url}/api/memories/${create1.json.memory.id}/related`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        memory: { id: string };
        related: { ratio: number; isDuplicate: boolean; isConflict: boolean }[];
      };
      expect(body.memory.id).toBe(create1.json.memory.id);
      expect(body.related.length).toBeGreaterThanOrEqual(1);
      expect(typeof body.related[0].ratio).toBe("number");
      expect(body.related[0].ratio >= 0 && body.related[0].ratio <= 1).toBe(true);
      expect(typeof body.related[0].isDuplicate).toBe("boolean");
      expect(typeof body.related[0].isConflict).toBe("boolean");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("returns 404 for unknown id", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const res = await fetch(`${server.url}/api/memories/mem_doesnotexist/related`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Not found");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});

describe("GET /api/memories", () => {
  it("supports date range filtering", async () => {
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
      expect(createB.json.status).toBe("active");

      const res = await fetch(`${server.url}/api/memories?from=${encodeURIComponent(T2)}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        total: number;
        memories: { id: string }[];
      };
      expect(body.total).toBe(1);
      expect(body.memories.length).toBe(1);
      expect(body.memories[0].id).toBe(createB.json.memory.id);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("supports sort and pagination", async () => {
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
      expect(page1.status).toBe(200);
      const page1Json = (await page1.json()) as {
        total: number;
        memories: { title: string }[];
      };
      expect(page1Json.memories.length).toBe(2);
      expect(page1Json.total).toBe(3);
      expect(page1Json.memories[0].title).toBe("Apple memory");
      expect(page1Json.memories[1].title).toBe("Banana memory");

      const page2 = await fetch(`${server.url}/api/memories?sort=title&order=asc&limit=2&offset=2`);
      expect(page2.status).toBe(200);
      const page2Json = (await page2.json()) as {
        total: number;
        memories: { title: string }[];
      };
      expect(page2Json.memories.length).toBe(1);
      expect(page2Json.total).toBe(3);
      expect(page2Json.memories[0].title).toBe("Cherry memory");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});

function waitForExit(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
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
