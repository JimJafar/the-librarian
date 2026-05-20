// HTTP session-route integration tests.
//
// Migrated from packages/mcp-server/tests/sessions.http.test.js as part
// of T4.1. Behaviour coverage is identical to the pre-migration suite —
// these tests spawn the compiled bin (`dist/bin/http.js`) and exercise
// the /api/sessions/* surface end-to-end.

import { createLibrarianStore } from "@librarian/core";
import { describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  makeTempDir,
  postJson,
  startHttpServer,
} from "../../../../test/helpers.js";

interface SessionRecord {
  id: string;
  title: string;
  status: string;
  rolling_summary: string | null;
  end_summary: string | null;
  current_harness: string | null;
}

interface SeedOverrides {
  agent_id?: string;
  title?: string;
  harness?: string;
  project_key?: string;
  visibility?: string;
  start_summary?: string;
}

async function seedSession(dataDir: string, overrides: SeedOverrides = {}): Promise<SessionRecord> {
  const store = createLibrarianStore({ dataDir });
  try {
    const result = store.startSession({
      agent_id: overrides.agent_id || "bede",
      title: overrides.title || "HTTP session",
      harness: overrides.harness || "hermes",
      project_key: overrides.project_key || "the-librarian",
      visibility: overrides.visibility || "common",
      start_summary: overrides.start_summary || "HTTP smoke test.",
    });
    return result.session as SessionRecord;
  } finally {
    store.close();
  }
}

describe("HTTP /api/sessions surface", () => {
  it("GET /api/sessions returns a sessions list with totals", async () => {
    const dataDir = makeTempDir();
    await seedSession(dataDir, { title: "First" });
    await seedSession(dataDir, { title: "Second" });
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.url}/api/sessions`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { sessions: SessionRecord[]; total: number };
      expect(Array.isArray(body.sessions)).toBe(true);
      expect(body.sessions.length).toBe(2);
      expect(body.sessions.some((s) => s.title === "First")).toBe(true);
      expect(body.sessions.some((s) => s.title === "Second")).toBe(true);
      expect(body.total).toBe(2);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("GET /api/sessions?include_archived=true reveals archived sessions", async () => {
    const dataDir = makeTempDir();
    const session = await seedSession(dataDir, { title: "Archive me" });
    const store = createLibrarianStore({ dataDir });
    try {
      store.archiveSession({ agent_id: "bede", session_id: session.id, reason: "tidy" });
    } finally {
      store.close();
    }
    const server = await startHttpServer({ dataDir });
    try {
      const def = (await (await fetch(`${server.url}/api/sessions`)).json()) as {
        sessions: SessionRecord[];
      };
      expect(def.sessions.length).toBe(0);
      const inc = (await (
        await fetch(`${server.url}/api/sessions?include_archived=true`)
      ).json()) as { sessions: SessionRecord[] };
      expect(inc.sessions.length).toBe(1);
      expect(inc.sessions[0].status).toBe("archived");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("GET /api/sessions/:id returns session detail", async () => {
    const dataDir = makeTempDir();
    const session = await seedSession(dataDir, { title: "Detail" });
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.url}/api/sessions/${session.id}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as SessionRecord;
      expect(body.id).toBe(session.id);
      expect(body.title).toBe("Detail");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("GET /api/sessions/:id returns 404 for unknown id", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.url}/api/sessions/ses_nope`);
      expect(response.status).toBe(404);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("GET /api/sessions/:id/events returns the per-session event stream", async () => {
    const dataDir = makeTempDir();
    const session = await seedSession(dataDir, { title: "Events" });
    const store = createLibrarianStore({ dataDir });
    try {
      store.recordSessionEvent({
        agent_id: "bede",
        session_id: session.id,
        type: "decision",
        summary: "D1",
      });
      store.recordSessionEvent({
        agent_id: "bede",
        session_id: session.id,
        type: "command",
        summary: "npm test",
      });
    } finally {
      store.close();
    }
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.url}/api/sessions/${session.id}/events`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { events: { type: string }[] };
      expect(body.events.length).toBeGreaterThanOrEqual(3);
      expect(body.events.some((event) => event.type === "decision")).toBe(true);
      expect(body.events.some((event) => event.type === "command")).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("POST /api/sessions/search runs an FTS search", async () => {
    const dataDir = makeTempDir();
    await seedSession(dataDir, {
      title: "BM25 finder",
      start_summary: "Investigating BM25 recall.",
    });
    await seedSession(dataDir, { title: "Other", start_summary: "Refactor the dashboard." });
    const server = await startHttpServer({ dataDir });
    try {
      const { response, json } = await postJson(`${server.url}/api/sessions/search`, {
        query: "BM25",
      });
      expect(response.status).toBe(200);
      expect(json.sessions.length).toBe(1);
      expect(json.sessions[0].title).toBe("BM25 finder");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("POST /api/sessions/:id/checkpoint updates rolling_summary", async () => {
    const dataDir = makeTempDir();
    const session = await seedSession(dataDir);
    const server = await startHttpServer({ dataDir });
    try {
      const { response, json } = await postJson(
        `${server.url}/api/sessions/${session.id}/checkpoint`,
        { summary: "Made progress." },
      );
      expect(response.status).toBe(200);
      expect(json.session.rolling_summary).toBe("Made progress.");
      expect(json.session.status).toBe("active");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("POST /api/sessions/:id/pause and /end transition the session", async () => {
    const dataDir = makeTempDir();
    const paused = await seedSession(dataDir, { title: "Pause me" });
    const ended = await seedSession(dataDir, { title: "End me" });
    const server = await startHttpServer({ dataDir });
    try {
      const pauseResp = await postJson(`${server.url}/api/sessions/${paused.id}/pause`, {
        summary: "EOD",
      });
      expect(pauseResp.json.session.status).toBe("paused");

      const endResp = await postJson(`${server.url}/api/sessions/${ended.id}/end`, {
        summary: "Done",
      });
      expect(endResp.json.session.status).toBe("ended");
      expect(endResp.json.session.end_summary).toBe("Done");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("POST /api/sessions/:id/archive hides from default list", async () => {
    const dataDir = makeTempDir();
    const session = await seedSession(dataDir, { title: "Archivable" });
    const server = await startHttpServer({ dataDir });
    try {
      const archive = await postJson(`${server.url}/api/sessions/${session.id}/archive`, {
        reason: "tidy",
      });
      expect(archive.json.session.status).toBe("archived");

      const list = (await (await fetch(`${server.url}/api/sessions`)).json()) as {
        sessions: SessionRecord[];
      };
      expect(list.sessions.length).toBe(0);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("POST /api/sessions/:id/restore and /delete round-trip a session", async () => {
    const dataDir = makeTempDir();
    const session = await seedSession(dataDir, { title: "Round trip" });
    const server = await startHttpServer({ dataDir });
    try {
      const del = await postJson(`${server.url}/api/sessions/${session.id}/delete`, {
        reason: "test",
      });
      expect(del.json.session.status).toBe("deleted");

      const restore = await postJson(`${server.url}/api/sessions/${session.id}/restore`, {});
      expect(restore.json.session.status).toBe("active");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("POST /api/sessions/:id/continue returns a handover package and attaches by default", async () => {
    const dataDir = makeTempDir();
    const session = await seedSession(dataDir, { title: "Handover" });
    const store = createLibrarianStore({ dataDir });
    try {
      store.checkpointSession({
        agent_id: "bede",
        session_id: session.id,
        summary: "Drafted handover.",
        next_steps: ["Add tests"],
      });
    } finally {
      store.close();
    }
    const server = await startHttpServer({ dataDir });
    try {
      const { response, json } = await postJson(
        `${server.url}/api/sessions/${session.id}/continue`,
        {
          target_harness: "codex",
          target_source_ref: "codex:r1",
          target_cwd: "/dev",
          format: "markdown",
        },
      );
      expect(response.status).toBe(200);
      expect(json.text).toMatch(/Librarian Session Handover/);
      expect(json.session.current_harness).toBe("codex");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("POST /api/sessions/:id/promote creates an active memory for non-protected categories", async () => {
    const dataDir = makeTempDir();
    const session = await seedSession(dataDir, { title: "Promote source" });
    const server = await startHttpServer({ dataDir });
    try {
      const { response, json } = await postJson(
        `${server.url}/api/sessions/${session.id}/promote`,
        {
          memory: {
            title: "Promoted via HTTP",
            body: "From a dashboard request.",
            category: "tools",
            visibility: "common",
            scope: "tool",
          },
        },
      );
      expect(response.status).toBe(200);
      expect(json.status).toBe("active");
      expect(json.memory.title).toBe("Promoted via HTTP");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("Dashboard HTML and JS expose the sessions UI surface", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const html = await (await fetch(`${server.url}/`)).text();
      expect(html).toMatch(/data-tab="sessions"/);
      expect(html).toMatch(/id="sessionsTab"/);
      expect(html).toMatch(/id="sessionList"/);
      expect(html).toMatch(/id="sessionDetail"/);
      expect(html).toMatch(/id="sessionSearch"/);

      const js = await (await fetch(`${server.url}/app.js`)).text();
      expect(js).toMatch(/loadSessions/);
      expect(js).toMatch(/renderSessionList/);
      expect(js).toMatch(/openSessionDetail/);
      expect(js).toMatch(/promoteSessionFact/);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("POST /api/sessions/:id/promote routes protected categories through the proposal flow", async () => {
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
          scope: "global",
        },
      });
      expect(json.status).toBe("proposed");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
