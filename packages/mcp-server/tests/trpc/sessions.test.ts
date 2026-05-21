// Session tRPC procedure integration tests (T4.5).
//
// Spawns the real HTTP bin and exercises every session procedure end
// to end: admin gating, list/get/events/search, full lifecycle
// (checkpoint/pause/end), archive/restore/delete, continue, promote.

import { createLibrarianStore } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

interface TrpcOk<T> {
  result: { data: T };
}

interface TrpcErr {
  error: { code?: number; message?: string; data?: { httpStatus?: number; code?: string } };
}

interface SessionRow {
  id: string;
  title: string;
  status: string;
  rolling_summary: string | null;
  end_summary: string | null;
  next_steps: string[];
}

interface SessionsListResult {
  sessions: SessionRow[];
  total: number;
  limit: number;
}

interface ServerHandle {
  url: string;
  token: string;
  stop: () => Promise<void>;
}

async function trpcGet<T>(server: ServerHandle, path: string, input?: unknown): Promise<T> {
  const url = new URL(`${server.url}/trpc/${path}`);
  if (input !== undefined) url.searchParams.set("input", JSON.stringify(input));
  const response = await fetch(url, { headers: { authorization: `Bearer ${server.token}` } });
  const json = (await response.json()) as TrpcOk<T> | TrpcErr;
  if (response.status >= 400 || "error" in json) {
    throw new Error(`trpc GET ${path} failed: ${JSON.stringify(json)}`);
  }
  return (json as TrpcOk<T>).result.data;
}

async function trpcPost<T>(server: ServerHandle, path: string, input?: unknown): Promise<T> {
  const response = await fetch(`${server.url}/trpc/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${server.token}`,
    },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const json = (await response.json()) as TrpcOk<T> | TrpcErr;
  if (response.status >= 400 || "error" in json) {
    throw new Error(`trpc POST ${path} failed: ${JSON.stringify(json)}`);
  }
  return (json as TrpcOk<T>).result.data;
}

function seedSession(
  dataDir: string,
  overrides: Partial<{
    title: string;
    agent_id: string;
    harness: string;
    project_key: string;
    start_summary: string;
  }> = {},
): SessionRow {
  const store = createLibrarianStore({ dataDir });
  try {
    const result = store.startSession({
      agent_id: overrides.agent_id || "bede",
      title: overrides.title || "tRPC session",
      harness: overrides.harness || "hermes",
      project_key: overrides.project_key || "the-librarian",
      start_summary: overrides.start_summary || "tRPC smoke test.",
    });
    if (!result.session) throw new Error("Failed to seed session");
    return result.session as SessionRow;
  } finally {
    store.close();
  }
}

describe("tRPC sessions surface", () => {
  it("rejects unauthenticated calls with UNAUTHORIZED", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.url}/trpc/sessions.list`);
      expect(response.status).toBe(401);
      const body = (await response.json()) as TrpcErr;
      expect(body.error?.data?.code).toBe("UNAUTHORIZED");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("sessions.list returns all sessions with admin scope", async () => {
    const dataDir = makeTempDir();
    seedSession(dataDir, { title: "Alpha" });
    seedSession(dataDir, { title: "Beta" });
    const server = await startHttpServer({ dataDir });
    try {
      const data = await trpcGet<SessionsListResult>(server, "sessions.list");
      expect(data.total).toBe(2);
      expect(data.sessions.map((s) => s.title).sort()).toEqual(["Alpha", "Beta"]);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("sessions.list include_ended reveals ended sessions", async () => {
    const dataDir = makeTempDir();
    const session = seedSession(dataDir, { title: "End me" });
    const store = createLibrarianStore({ dataDir });
    try {
      store.endSession({ agent_id: "bede", session_id: session.id, summary: "Done." });
    } finally {
      store.close();
    }
    const server = await startHttpServer({ dataDir });
    try {
      const without = await trpcGet<SessionsListResult>(server, "sessions.list");
      expect(without.total).toBe(0);
      const withEnded = await trpcGet<SessionsListResult>(server, "sessions.list", {
        include_ended: true,
      });
      expect(withEnded.total).toBe(1);
      expect(withEnded.sessions[0]?.status).toBe("ended");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("sessions.get returns the session detail or NOT_FOUND", async () => {
    const dataDir = makeTempDir();
    const session = seedSession(dataDir, { title: "Detail" });
    const server = await startHttpServer({ dataDir });
    try {
      const data = await trpcGet<SessionRow>(server, "sessions.get", { session_id: session.id });
      expect(data.id).toBe(session.id);

      const missing = await fetch(
        `${server.url}/trpc/sessions.get?input=${encodeURIComponent(
          JSON.stringify({ session_id: "ses_nope" }),
        )}`,
        { headers: { authorization: `Bearer ${server.token}` } },
      );
      expect(missing.status).toBe(404);
      const body = (await missing.json()) as TrpcErr;
      expect(body.error?.data?.code).toBe("NOT_FOUND");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("sessions.events returns the per-session event stream", async () => {
    const dataDir = makeTempDir();
    const session = seedSession(dataDir, { title: "Events" });
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
      const data = await trpcGet<{ events: { type: string; summary: string }[]; total: number }>(
        server,
        "sessions.events",
        { session_id: session.id },
      );
      // startSession also lands a row in session_events ("Started …"),
      // so we look for the two recordSessionEvent rows alongside it.
      expect(data.total).toBeGreaterThanOrEqual(3);
      const summaries = data.events.map((e) => e.summary);
      expect(summaries).toContain("D1");
      expect(summaries).toContain("npm test");

      const filtered = await trpcGet<{ events: { type: string }[] }>(server, "sessions.events", {
        session_id: session.id,
        type: "decision",
      });
      expect(filtered.events.length).toBe(1);
      expect(filtered.events[0]?.type).toBe("decision");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("sessions.events returns NOT_FOUND for unknown id", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(
        `${server.url}/trpc/sessions.events?input=${encodeURIComponent(
          JSON.stringify({ session_id: "ses_nope" }),
        )}`,
        { headers: { authorization: `Bearer ${server.token}` } },
      );
      expect(response.status).toBe(404);
      const body = (await response.json()) as TrpcErr;
      expect(body.error?.data?.code).toBe("NOT_FOUND");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("sessions.search matches sessions by query", async () => {
    const dataDir = makeTempDir();
    seedSession(dataDir, { title: "Coffee plan", start_summary: "espresso routines" });
    seedSession(dataDir, { title: "Logging", start_summary: "switch to pino" });
    const server = await startHttpServer({ dataDir });
    try {
      const data = await trpcGet<SessionsListResult>(server, "sessions.search", {
        query: "coffee",
      });
      expect(data.sessions.some((s) => s.title === "Coffee plan")).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("sessions.checkpoint, pause, end drive the full lifecycle", async () => {
    const dataDir = makeTempDir();
    const session = seedSession(dataDir, { title: "Lifecycle" });
    const server = await startHttpServer({ dataDir });
    try {
      const checkpoint = await trpcPost<{ session: SessionRow }>(server, "sessions.checkpoint", {
        session_id: session.id,
        summary: "midpoint",
        next_steps: ["step A"],
      });
      expect(checkpoint.session.status).toBe("active");
      expect(checkpoint.session.rolling_summary).toContain("midpoint");

      const paused = await trpcPost<{ session: SessionRow }>(server, "sessions.pause", {
        session_id: session.id,
        summary: "stepping away",
      });
      expect(paused.session.status).toBe("paused");

      const ended = await trpcPost<{ session: SessionRow }>(server, "sessions.end", {
        session_id: session.id,
        summary: "wrap",
      });
      expect(ended.session.status).toBe("ended");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("sessions.archive / restore / delete procedures are retired (return NOT_FOUND)", async () => {
    // S1.1: the procedures no longer exist. Dashboard consumers should
    // call sessions.end (for the end intent) and sessions.continue (for
    // resume on an ended row).
    const dataDir = makeTempDir();
    const session = seedSession(dataDir, { title: "Retired" });
    const server = await startHttpServer({ dataDir });
    try {
      for (const dropped of ["sessions.archive", "sessions.restore", "sessions.delete"]) {
        const response = await fetch(`${server.url}/trpc/${dropped}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${server.token}`,
          },
          body: JSON.stringify({ session_id: session.id }),
        });
        expect(response.status).toBe(404);
        const json = (await response.json()) as TrpcErr;
        expect(json.error?.data?.code).toBe("NOT_FOUND");
      }
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("sessions.continue returns a handover package", async () => {
    const dataDir = makeTempDir();
    const session = seedSession(dataDir, { title: "Continue me" });
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<{
        session: SessionRow;
        handover: { session: SessionRow };
        text: string;
        format: string;
      }>(server, "sessions.continue", {
        session_id: session.id,
        target_harness: "claude-code",
      });
      expect(result.session.id).toBe(session.id);
      expect(typeof result.text).toBe("string");
      expect(result.text.length).toBeGreaterThan(0);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("sessions.continue works without a target_harness (no attach)", async () => {
    const dataDir = makeTempDir();
    const session = seedSession(dataDir, { title: "Read-only handover" });
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<{
        session: SessionRow;
        text: string;
      }>(server, "sessions.continue", { session_id: session.id, attach: false });
      expect(result.session.id).toBe(session.id);
      expect(typeof result.text).toBe("string");
      expect(result.text.length).toBeGreaterThan(0);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("sessions.end forwards candidate_memories into the event payload", async () => {
    const dataDir = makeTempDir();
    const session = seedSession(dataDir, { title: "Ending with candidates" });
    const server = await startHttpServer({ dataDir });
    try {
      await trpcPost<{ session: SessionRow }>(server, "sessions.end", {
        session_id: session.id,
        summary: "wrapping up",
        candidate_memories: [
          { title: "candidate A", body: "promote me", category: "lessons", agent_id: "bede" },
        ],
      });
      const events = await trpcGet<{
        events: { type: string; summary: string; payload: Record<string, unknown> }[];
      }>(server, "sessions.events", { session_id: session.id });
      const endEvent = events.events.find((e) => e.type === "ended");
      expect(endEvent).toBeTruthy();
      const candidates = endEvent?.payload.candidate_memories as { title: string }[] | undefined;
      expect(Array.isArray(candidates)).toBe(true);
      expect(candidates?.[0]?.title).toBe("candidate A");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("sessions.pause on an ended session resumes it as paused (S1.1: ended is not terminal)", async () => {
    const dataDir = makeTempDir();
    const session = seedSession(dataDir, { title: "Already ended" });
    const store = createLibrarianStore({ dataDir });
    try {
      store.endSession({ admin: true, agent_id: "bede", session_id: session.id, summary: "done" });
    } finally {
      store.close();
    }
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<{ session: SessionRow }>(server, "sessions.pause", {
        session_id: session.id,
        summary: "Picked back up",
      });
      expect(result.session.status).toBe("paused");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("sessions.promote turns a session fact into a memory", async () => {
    const dataDir = makeTempDir();
    const session = seedSession(dataDir, { title: "Source" });
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<{
        status: string;
        memory?: { id: string; title: string };
      }>(server, "sessions.promote", {
        session_id: session.id,
        memory: {
          agent_id: "bede",
          title: "Lesson from session",
          body: "Promote facts via tRPC.",
          category: "lessons",
        },
      });
      expect(result.status).toBe("active");
      expect(result.memory?.title).toBe("Lesson from session");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("sessions.checkpoint / pause / end / continue / promote return NOT_FOUND for unknown ids", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const actions: [string, Record<string, unknown>][] = [
        ["sessions.checkpoint", { session_id: "ses_nope", summary: "x" }],
        ["sessions.pause", { session_id: "ses_nope" }],
        ["sessions.end", { session_id: "ses_nope" }],
        ["sessions.continue", { session_id: "ses_nope" }],
        [
          "sessions.promote",
          {
            session_id: "ses_nope",
            memory: { agent_id: "bede", title: "x", body: "x", category: "lessons" },
          },
        ],
      ];
      for (const [path, body] of actions) {
        const response = await fetch(`${server.url}/trpc/${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${server.token}`,
          },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(404);
        const json = (await response.json()) as TrpcErr;
        expect(json.error?.data?.code).toBe("NOT_FOUND");
      }
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
