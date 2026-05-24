import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatSessionLifecycle,
  formatSessionList,
  formatSessionStart,
} from "@librarian/mcp-server/formatters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Exercises the BUILT helper bin end-to-end against a fake Librarian /mcp that
// returns the REAL formatter prose, so the verb→tool mapping, prose parsing, and
// stdout/exit-code contract are all covered. The package `test` script builds
// before vitest runs.
const binPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "bin",
  "mcp-call.js",
);

const TOKEN = "tok_bin_test";

function session(overrides: Record<string, unknown> = {}): never {
  return {
    id: "ses_bin",
    status: "active",
    title: "Bin test",
    visibility: "common",
    project_key: "the-librarian",
    current_harness: "claude-code",
    start_summary: "go",
    last_activity_at: "2026-05-24T10:00:00.000Z",
    next_steps: [],
    tags: [],
    ...overrides,
  } as never;
}

function rpc(text: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });
}

let server: http.Server;
let url: string;
let lastAuth: string | undefined;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastAuth = req.headers.authorization;
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const name = payload.params?.name as string;
      const args = (payload.params?.arguments ?? {}) as Record<string, unknown>;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(rpc(responseFor(name, args)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function responseFor(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "start_session":
      return formatSessionStart(session({ id: "ses_started", title: args.title ?? "Bin test" }));
    case "list_sessions":
      return formatSessionList({
        total: 2,
        sessions: [session({ id: "ses_one" }), session({ id: "ses_two", status: "paused" })],
      } as never);
    case "continue_session":
      return args.session_id === "ses_missing"
        ? "No session found for id ses_missing."
        : `Handover for ${String(args.session_id)} — pick up where you left off.`;
    case "checkpoint_session":
      return formatSessionLifecycle(session(), "Checkpoint recorded.");
    case "pause_session":
      return formatSessionLifecycle(session({ status: "paused" }), "Session paused.");
    case "end_session":
      return formatSessionLifecycle(session({ status: "ended" }), "Session ended.");
    default:
      return `Unknown tool ${name}`;
  }
}

interface BinResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Invoke the built bin with ASYNC spawn (not spawnSync): the fake server runs in
// THIS process, so a synchronous spawn would block the event loop and deadlock
// the server it's waiting on. In production the server is remote, so the remote
// CLI's spawnSync is fine — and is unit-tested separately with an injected runner.
function runBin(
  verb: string,
  args: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<BinResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [binPath, verb], {
      env: { ...process.env, LIBRARIAN_MCP_URL: url, LIBRARIAN_AGENT_TOKEN: TOKEN, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.write(JSON.stringify(args));
    child.stdin.end();
  });
}

describe("mcp-call bin", () => {
  it("start: returns the parsed session and sends the bearer token", async () => {
    const r = await runBin("start", { harness: "claude-code", cwd: "/x", summary: "go" });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).session).toMatchObject({ id: "ses_started", status: "active" });
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
  });

  it("list: returns every session id+status", async () => {
    const r = await runBin("list", { harness: "claude-code" });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.sessions.map((s: { id: string }) => s.id)).toEqual(["ses_one", "ses_two"]);
    expect(out.sessions.map((s: { status: string }) => s.status)).toEqual(["active", "paused"]);
  });

  it("continue: synthesizes the session from the passed id", async () => {
    const r = await runBin("continue", {
      sessionId: "ses_keep",
      harness: "claude-code",
      cwd: "/x",
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).session).toMatchObject({ id: "ses_keep", status: "active" });
  });

  it("continue: fails when the server reports no such session", async () => {
    const r = await runBin("continue", { sessionId: "ses_missing" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
  });

  it("checkpoint: succeeds with ok", async () => {
    const r = await runBin("checkpoint", { sessionId: "ses_bin", summary: "did work" });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true });
  });

  it("end: succeeds with ok", async () => {
    const r = await runBin("end", { sessionId: "ses_bin", reason: "switching to private mode" });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true });
  });

  it("fails (exit 1) when the endpoint env is missing", async () => {
    const r = await runBin("start", {}, { LIBRARIAN_MCP_URL: "", LIBRARIAN_AGENT_TOKEN: "" });
    expect(r.status).not.toBe(0);
  });

  it("fails (exit 1) on an unknown verb", async () => {
    const r = await runBin("frobnicate", {});
    expect(r.status).not.toBe(0);
  });
});
