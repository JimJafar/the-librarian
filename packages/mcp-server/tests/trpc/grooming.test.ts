// Memory-curator admin tRPC procedure tests (§7.1/§13). Spawns the real HTTP bin
// and exercises the cockpit surface end to end: admin gating, NON-LLM config
// read/update round-trip (the LLM connection lives under the `llm` router now),
// run observability, and run-now. Run-now is an ADMIN OVERRIDE (spec 045 D-4): it
// grooms even a disabled job (LLM-config/token gates still apply), so the enable
// gate no longer refuses it.

import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  addProvider,
  createLibrarianStore,
  resolveSecretKey,
  writeConsumerConfig,
  writeGroomingConfig,
} from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

// Assemble the 64-hex key + Buffer at runtime — no secret-shaped literal (GitGuardian).
const SECRET_KEY_HEX = "0123456789abcdef".repeat(4);
const SECRET_KEY = resolveSecretKey(SECRET_KEY_HEX);

// Seed an ENABLED + fully-configured grooming job with one active memory, so a
// grooming pass over that slice has real input. Shares the server's master key so
// the provider token round-trips.
function seedEnabledGrooming(dataDir: string, stubUrl: string): void {
  const seed = createLibrarianStore({ dataDir, secretKey: SECRET_KEY });
  writeGroomingConfig(seed, { enabled: true });
  const provider = addProvider(seed, {
    name: "stub",
    endpoint: stubUrl,
    token: "dummy-stub-token",
  });
  writeConsumerConfig(seed, "grooming", { providerId: provider.id, model: "gpt-x" });
  seed.createMemory({
    agent_id: "agent-a",
    title: "Active anchor",
    body: "b",
    category: "lessons",
    visibility: "common",
    scope: "project",
    project_key: "proj-x",
    priority: "normal",
    confidence: "working",
  });
  seed.close();
}

interface TrpcOk<T> {
  result: { data: T };
}
interface TrpcErr {
  error: unknown;
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
    headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const json = (await response.json()) as TrpcOk<T> | TrpcErr;
  if (response.status >= 400 || "error" in json) {
    throw new Error(`trpc POST ${path} failed: ${JSON.stringify(json)}`);
  }
  return (json as TrpcOk<T>).result.data;
}

interface GroomingConfig {
  enabled: boolean;
  applyConfidenceThreshold: number;
  intervalDays: number;
  scheduleTime: string;
}

// A minimal OpenAI-compatible chat-completions stub the grooming LLM client can
// talk to. Returns an empty `operations` judgment so a pass runs end-to-end (and
// reports ran:true) without proposing or applying anything destructive.
function startStubLlm(): Promise<{ url: string; stop: () => Promise<void> }> {
  const judgment = JSON.stringify({ operations: [] });
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: judgment } }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("tRPC grooming surface", () => {
  it("requires admin auth", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.url}/trpc/grooming.config`); // no Authorization
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("rejects an agent-role token on run-now (§12 — no consumer-reachable trigger)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir }); // agentToken defaults to "agent-token"
    try {
      const response = await fetch(`${server.url}/trpc/grooming.runNow`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer agent-token" },
      });
      expect(response.status).toBeGreaterThanOrEqual(400); // agent role is not admin
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("reads safe defaults and round-trips a config update (no token)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const before = await trpcGet<GroomingConfig>(server, "grooming.config");
      expect(before.enabled).toBe(false);
      expect(before.applyConfidenceThreshold).toBeCloseTo(0.8); // the D13 default

      const after = await trpcPost<GroomingConfig>(server, "grooming.setConfig", {
        enabled: true,
        applyConfidenceThreshold: 0.9,
      });
      expect(after.enabled).toBe(true);
      expect(after.applyConfidenceThreshold).toBeCloseTo(0.9);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("config exposes the grooming schedule cadence (default every 1 day at 03:00)", async () => {
    // D-3: the grooming wall-clock schedule is part of the admin config read (via
    // readGroomingConfig), so the dashboard's Grooming control has values to render.
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const config = await trpcGet<GroomingConfig>(server, "grooming.config");
      expect(config.intervalDays).toBe(1);
      expect(config.scheduleTime).toBe("03:00");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("setConfig persists the grooming schedule cadence and reads it back", async () => {
    // D-3: the admin can SET the cadence over tRPC; it round-trips through the core
    // writeGroomingConfig (the single source of truth) and is visible on the next read.
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const updated = await trpcPost<GroomingConfig>(server, "grooming.setConfig", {
        intervalDays: 7,
        scheduleTime: "04:30",
      });
      expect(updated.intervalDays).toBe(7);
      expect(updated.scheduleTime).toBe("04:30");
      // Read-back through a fresh query proves it persisted, not just echoed.
      const reread = await trpcGet<GroomingConfig>(server, "grooming.config");
      expect(reread.intervalDays).toBe(7);
      expect(reread.scheduleTime).toBe("04:30");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("setConfig rejects an invalid grooming schedule with the core teaching error", async () => {
    // Validation defers to the core writer (writeGroomingConfig). An interval_days of 0
    // and a malformed schedule_time are both rejected and surfaced as a tRPC error.
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const badDays = await fetch(`${server.url}/trpc/grooming.setConfig`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ intervalDays: 0 }),
      });
      expect(badDays.status).toBeGreaterThanOrEqual(400);
      const daysJson = (await badDays.json()) as { error?: { message?: string } };
      expect(daysJson.error?.message).toMatch(/interval_days must be an integer >= 1/);

      const badTime = await fetch(`${server.url}/trpc/grooming.setConfig`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ scheduleTime: "25:00" }),
      });
      expect(badTime.status).toBeGreaterThanOrEqual(400);
      const timeJson = (await badTime.json()) as { error?: { message?: string } };
      expect(timeJson.error?.message).toMatch(/schedule_time must be HH:MM/);

      // Neither rejected write persisted — the schedule stays at its defaults.
      const config = await trpcGet<GroomingConfig>(server, "grooming.config");
      expect(config.intervalDays).toBe(1);
      expect(config.scheduleTime).toBe("03:00");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("lists runs (empty initially); run-now bypasses the enable gate but still needs an LLM", async () => {
    // Run-now is an admin override (spec 045 D-4): it no longer refuses a disabled
    // job. With no LLM configured it bypasses the enable gate and surfaces the next
    // gate's reason (incomplete_config) — the dashboard shows that, never "disabled".
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const runs = await trpcGet<unknown[]>(server, "grooming.runs");
      expect(runs).toEqual([]);

      const result = await trpcPost<{ ran: boolean; reason?: string }>(server, "grooming.runNow");
      expect(result).toEqual({ ran: false, reason: "incomplete_config" });
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("run-now grooms a DISABLED but fully-configured job (admin override, spec 045 D-4)", async () => {
    // The behaviour change: grooming stays disabled, yet an admin run-now runs a
    // real pass (ran:true). A decryptable token needs the master key — assembled at
    // runtime so no key-shaped literal lands in committed source.
    const secretKey = "0123456789abcdef".repeat(4);
    const stub = await startStubLlm();
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir, secretKey });
    try {
      // Point the grooming consumer at the stub LLM, but leave grooming DISABLED.
      const provider = await trpcPost<{ id: string }>(server, "llm.addProvider", {
        name: "stub",
        endpoint: stub.url,
        token: "dummy-stub-token",
      });
      await trpcPost(server, "llm.setConsumerConfig", {
        consumer: "grooming",
        providerId: provider.id,
        model: "gpt-x",
      });
      const config = await trpcGet<GroomingConfig>(server, "grooming.config");
      expect(config.enabled).toBe(false); // still disabled — run-now overrides it

      const result = await trpcPost<{ ran: boolean; reason?: string }>(server, "grooming.runNow");
      expect(result.ran).toBe(true);
    } finally {
      await server.stop();
      await stub.stop();
      cleanupTempDir(dataDir);
    }
  });

  // Regression (feat/curator-job-control): the grooming boot scan must be GATED on
  // its scheduler timer being live. With the timer OFF (LIBRARIAN_GROOMING_TICK_MS=0)
  // a restart must NOT groom the corpus — disabling the timer means "no automatic
  // grooming at all", not "no timer but still one pass per boot". Without the gate, a
  // server that seeds enabled+configured grooming before boot grooms the whole corpus
  // at startup, polluting any test that acts on that corpus (the dry-run / re-evaluate
  // tRPC tests). Run-now still works regardless.
  it("does NOT run a grooming boot scan when the scheduler timer is disabled (tick=0)", async () => {
    const stub = await startStubLlm();
    const dataDir = makeTempDir();
    // The shared helper pins LIBRARIAN_GROOMING_TICK_MS=0 by default, so the grooming
    // scheduler (and its boot scan) is off.
    seedEnabledGrooming(dataDir, stub.url);
    const server = await startHttpServer({ dataDir, secretKey: SECRET_KEY_HEX });
    try {
      // No boot scan fired: no curation run was recorded at startup.
      const runs = await trpcGet<unknown[]>(server, "grooming.runs");
      expect(runs).toEqual([]);
    } finally {
      await server.stop();
      await stub.stop();
      cleanupTempDir(dataDir);
    }
  });
});
