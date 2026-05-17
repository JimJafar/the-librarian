import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanupTempDir,
  makeTempDir,
  postJson,
  startHttpServer
} from "./helpers.js";
import { LibrarianStore } from "../src/store.js";

async function seedSession(dataDir, overrides = {}) {
  const store = new LibrarianStore({ dataDir });
  try {
    return store.startSession({
      agent_id: overrides.agent_id || "bede",
      title: overrides.title || "HTTP session",
      harness: overrides.harness || "hermes",
      project_key: overrides.project_key || "the-librarian",
      visibility: overrides.visibility || "common",
      start_summary: overrides.start_summary || "HTTP smoke test."
    }).session;
  } finally {
    store.close();
  }
}

test("GET /api/sessions returns a sessions list with totals", async () => {
  const dataDir = makeTempDir();
  await seedSession(dataDir, { title: "First" });
  await seedSession(dataDir, { title: "Second" });
  const server = await startHttpServer({ dataDir });
  try {
    const response = await fetch(`${server.url}/api/sessions`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.sessions));
    assert.equal(body.sessions.length, 2);
    assert.ok(body.sessions.some((s) => s.title === "First"));
    assert.ok(body.sessions.some((s) => s.title === "Second"));
    assert.equal(body.total, 2);
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("GET /api/sessions?include_archived=true reveals archived sessions", async () => {
  const dataDir = makeTempDir();
  const session = await seedSession(dataDir, { title: "Archive me" });
  const store = new LibrarianStore({ dataDir });
  try {
    store.archiveSession({ agent_id: "bede", session_id: session.id, reason: "tidy" });
  } finally {
    store.close();
  }
  const server = await startHttpServer({ dataDir });
  try {
    const def = await (await fetch(`${server.url}/api/sessions`)).json();
    assert.equal(def.sessions.length, 0);
    const inc = await (await fetch(`${server.url}/api/sessions?include_archived=true`)).json();
    assert.equal(inc.sessions.length, 1);
    assert.equal(inc.sessions[0].status, "archived");
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("GET /api/sessions/:id returns session detail", async () => {
  const dataDir = makeTempDir();
  const session = await seedSession(dataDir, { title: "Detail" });
  const server = await startHttpServer({ dataDir });
  try {
    const response = await fetch(`${server.url}/api/sessions/${session.id}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.id, session.id);
    assert.equal(body.title, "Detail");
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("GET /api/sessions/:id returns 404 for unknown id", async () => {
  const dataDir = makeTempDir();
  const server = await startHttpServer({ dataDir });
  try {
    const response = await fetch(`${server.url}/api/sessions/ses_nope`);
    assert.equal(response.status, 404);
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("GET /api/sessions/:id/events returns the per-session event stream", async () => {
  const dataDir = makeTempDir();
  const session = await seedSession(dataDir, { title: "Events" });
  const store = new LibrarianStore({ dataDir });
  try {
    store.recordSessionEvent({ agent_id: "bede", session_id: session.id, type: "decision", summary: "D1" });
    store.recordSessionEvent({ agent_id: "bede", session_id: session.id, type: "command", summary: "npm test" });
  } finally {
    store.close();
  }
  const server = await startHttpServer({ dataDir });
  try {
    const response = await fetch(`${server.url}/api/sessions/${session.id}/events`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.events.length >= 3);
    assert.ok(body.events.some((event) => event.type === "decision"));
    assert.ok(body.events.some((event) => event.type === "command"));
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("POST /api/sessions/search runs an FTS search", async () => {
  const dataDir = makeTempDir();
  await seedSession(dataDir, { title: "BM25 finder", start_summary: "Investigating BM25 recall." });
  await seedSession(dataDir, { title: "Other", start_summary: "Refactor the dashboard." });
  const server = await startHttpServer({ dataDir });
  try {
    const { response, json } = await postJson(`${server.url}/api/sessions/search`, { query: "BM25" });
    assert.equal(response.status, 200);
    assert.equal(json.sessions.length, 1);
    assert.equal(json.sessions[0].title, "BM25 finder");
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("POST /api/sessions/:id/checkpoint updates rolling_summary", async () => {
  const dataDir = makeTempDir();
  const session = await seedSession(dataDir);
  const server = await startHttpServer({ dataDir });
  try {
    const { response, json } = await postJson(`${server.url}/api/sessions/${session.id}/checkpoint`, {
      summary: "Made progress."
    });
    assert.equal(response.status, 200);
    assert.equal(json.session.rolling_summary, "Made progress.");
    assert.equal(json.session.status, "active");
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("POST /api/sessions/:id/pause and /end transition the session", async () => {
  const dataDir = makeTempDir();
  const paused = await seedSession(dataDir, { title: "Pause me" });
  const ended = await seedSession(dataDir, { title: "End me" });
  const server = await startHttpServer({ dataDir });
  try {
    const pauseResp = await postJson(`${server.url}/api/sessions/${paused.id}/pause`, { summary: "EOD" });
    assert.equal(pauseResp.json.session.status, "paused");

    const endResp = await postJson(`${server.url}/api/sessions/${ended.id}/end`, { summary: "Done" });
    assert.equal(endResp.json.session.status, "ended");
    assert.equal(endResp.json.session.end_summary, "Done");
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("POST /api/sessions/:id/archive hides from default list", async () => {
  const dataDir = makeTempDir();
  const session = await seedSession(dataDir, { title: "Archivable" });
  const server = await startHttpServer({ dataDir });
  try {
    const archive = await postJson(`${server.url}/api/sessions/${session.id}/archive`, { reason: "tidy" });
    assert.equal(archive.json.session.status, "archived");

    const list = await (await fetch(`${server.url}/api/sessions`)).json();
    assert.equal(list.sessions.length, 0);
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("POST /api/sessions/:id/restore and /delete round-trip a session", async () => {
  const dataDir = makeTempDir();
  const session = await seedSession(dataDir, { title: "Round trip" });
  const server = await startHttpServer({ dataDir });
  try {
    const del = await postJson(`${server.url}/api/sessions/${session.id}/delete`, { reason: "test" });
    assert.equal(del.json.session.status, "deleted");

    const restore = await postJson(`${server.url}/api/sessions/${session.id}/restore`, {});
    assert.equal(restore.json.session.status, "active");
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("POST /api/sessions/:id/continue returns a handover package and attaches by default", async () => {
  const dataDir = makeTempDir();
  const session = await seedSession(dataDir, { title: "Handover" });
  const store = new LibrarianStore({ dataDir });
  try {
    store.checkpointSession({
      agent_id: "bede",
      session_id: session.id,
      summary: "Drafted handover.",
      next_steps: ["Add tests"]
    });
  } finally {
    store.close();
  }
  const server = await startHttpServer({ dataDir });
  try {
    const { response, json } = await postJson(`${server.url}/api/sessions/${session.id}/continue`, {
      target_harness: "codex",
      target_source_ref: "codex:r1",
      target_cwd: "/dev",
      format: "markdown"
    });
    assert.equal(response.status, 200);
    assert.match(json.text, /Librarian Session Handover/);
    assert.equal(json.session.current_harness, "codex", "default attach should switch current harness");
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("POST /api/sessions/:id/promote creates an active memory for non-protected categories", async () => {
  const dataDir = makeTempDir();
  const session = await seedSession(dataDir, { title: "Promote source" });
  const server = await startHttpServer({ dataDir });
  try {
    const { response, json } = await postJson(`${server.url}/api/sessions/${session.id}/promote`, {
      memory: {
        title: "Promoted via HTTP",
        body: "From a dashboard request.",
        category: "tools",
        visibility: "common",
        scope: "tool"
      }
    });
    assert.equal(response.status, 200);
    assert.equal(json.status, "active");
    assert.equal(json.memory.title, "Promoted via HTTP");
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});

test("POST /api/sessions/:id/promote routes protected categories through the proposal flow", async () => {
  const dataDir = makeTempDir();
  const session = await seedSession(dataDir, { title: "Protected promote" });
  const server = await startHttpServer({ dataDir });
  try {
    const { json } = await postJson(`${server.url}/api/sessions/${session.id}/promote`, {
      memory: {
        title: "User identity fact",
        body: "Jim runs The Librarian as the shared session backend.",
        category: "identity",
        visibility: "common",
        scope: "global"
      }
    });
    assert.equal(json.status, "proposed");
  } finally {
    await server.stop();
    cleanupTempDir(dataDir);
  }
});
