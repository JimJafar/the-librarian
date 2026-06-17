// Server auto-update admin tRPC procedure tests (spec 2026-06-16-server-autoupdate
// T2). The dashboard/CLI/host-wrapper read+write the auto-update settings through
// this router: admin gating on every procedure (served only on the internal
// listener, ADR 0008 P3), the `get` aggregation (enabled, cadence, lastRunAt +
// version/latest reused from health's release lookup), and the `set` toggle +
// cadence round-trip with the core teaching error on a bad cadence.

import { createLibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

interface TrpcOk<T> {
  result: { data: T };
}
interface TrpcErr {
  error: unknown;
}
interface ServerHandle {
  trpcUrl: string;
  token: string;
  stop: () => Promise<void>;
}

async function trpcGet<T>(server: ServerHandle, path: string, input?: unknown): Promise<T> {
  const url = new URL(`${server.trpcUrl}/trpc/${path}`);
  if (input !== undefined) url.searchParams.set("input", JSON.stringify(input));
  const response = await fetch(url, { headers: { authorization: `Bearer ${server.token}` } });
  const json = (await response.json()) as TrpcOk<T> | TrpcErr;
  if (response.status >= 400 || "error" in json) {
    throw new Error(`trpc GET ${path} failed: ${JSON.stringify(json)}`);
  }
  return (json as TrpcOk<T>).result.data;
}

async function trpcPost<T>(server: ServerHandle, path: string, input?: unknown): Promise<T> {
  const response = await fetch(`${server.trpcUrl}/trpc/${path}`, {
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

interface AutoUpdateConfig {
  enabled: boolean;
  cadence: "daily" | "weekly";
  lastRunAt: string | null;
}
interface AutoUpdateGet extends AutoUpdateConfig {
  version: string;
  latest: { kind: string };
}

describe("tRPC autoupdate surface", () => {
  let dataDir = "";
  beforeEach(() => {
    // Disable the GitHub version check so `get` never hits the network in CI.
    process.env.LIBRARIAN_DISABLE_VERSION_CHECK = "true";
    dataDir = makeTempDir();
  });
  afterEach(() => {
    delete process.env.LIBRARIAN_DISABLE_VERSION_CHECK;
    cleanupTempDir(dataDir);
  });

  it("every procedure is unreachable from the public (network) listener (ADR 0008 P3)", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      // Post-P3 the admin gate is the network boundary: the autoupdate procedures
      // are served only on the internal listener and 404 on the public port — even
      // for a network agent's bearer.
      const getResp = await fetch(`${server.url}/trpc/autoupdate.get`, {
        headers: { authorization: "Bearer agent-token" },
      });
      expect(getResp.status).toBe(404);

      const setResp = await fetch(`${server.url}/trpc/autoupdate.set`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer agent-token" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(setResp.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it("get returns the default config (disabled, daily, never run) plus version/latest", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const config = await trpcGet<AutoUpdateGet>(server, "autoupdate.get");
      expect(config.enabled).toBe(false);
      expect(config.cadence).toBe("daily");
      expect(config.lastRunAt).toBeNull();
      // version is the running build; latest comes from health's release lookup
      // (disabled in this test → `{ kind: "disabled" }`), proving the reuse wires up.
      expect(typeof config.version).toBe("string");
      expect(config.latest.kind).toBe("disabled");
    } finally {
      await server.stop();
    }
  });

  it("set round-trips the enablement toggle (default off, authoritative)", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const enabled = await trpcPost<AutoUpdateConfig>(server, "autoupdate.set", { enabled: true });
      expect(enabled.enabled).toBe(true);
      expect(await trpcGet<AutoUpdateGet>(server, "autoupdate.get").then((c) => c.enabled)).toBe(
        true,
      );

      const disabled = await trpcPost<AutoUpdateConfig>(server, "autoupdate.set", {
        enabled: false,
      });
      expect(disabled.enabled).toBe(false);
      expect(await trpcGet<AutoUpdateGet>(server, "autoupdate.get").then((c) => c.enabled)).toBe(
        false,
      );
    } finally {
      await server.stop();
    }
  });

  it("set persists the cadence (daily|weekly) and reads it back", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const updated = await trpcPost<AutoUpdateConfig>(server, "autoupdate.set", {
        cadence: "weekly",
      });
      expect(updated.cadence).toBe("weekly");
      // Read-back through a fresh query proves it persisted, not just echoed.
      const reread = await trpcGet<AutoUpdateGet>(server, "autoupdate.get");
      expect(reread.cadence).toBe("weekly");
      // The cadence is independent of the enablement toggle (a partial patch).
      expect(reread.enabled).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it("set rejects an invalid cadence with the core teaching error and persists nothing", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.trpcUrl}/trpc/autoupdate.set`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ enabled: true, cadence: "hourly" }),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      const json = (await response.json()) as { error?: { message?: string } };
      expect(json.error?.message).toMatch(/cadence must be one of/i);

      // The rejected patch persisted NOTHING — cadence is still default, and the
      // `enabled: true` in the same call did not slip through (cadence validated first).
      const config = await trpcGet<AutoUpdateGet>(server, "autoupdate.get");
      expect(config.cadence).toBe("daily");
      expect(config.enabled).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it("get reflects a last-run timestamp stamped out of band (the host wrapper's stamp)", async () => {
    // The host wrapper stamps `server.autoupdate.last_run_at` after a successful
    // update; the dashboard reads it back through `get`. Seed it via a store on the
    // same dataDir before boot to prove the read path surfaces the ISO string.
    const seed = createLibrarianStore({ dataDir });
    const at = new Date("2026-06-15T09:30:00.000Z");
    seed.setSetting("server.autoupdate.last_run_at", at.toISOString());
    seed.close();

    const server = await startHttpServer({ dataDir });
    try {
      const config = await trpcGet<AutoUpdateGet>(server, "autoupdate.get");
      expect(config.lastRunAt).toBe(at.toISOString());
    } finally {
      await server.stop();
    }
  });

  it("stampRun sets last_run_at to now (the host wrapper's post-update stamp)", async () => {
    // The `--run` wrapper calls stampRun ONLY after a successful update. Before it,
    // last_run_at is null (never run); after it, it's a recent ISO timestamp.
    const server = await startHttpServer({ dataDir });
    try {
      expect(
        await trpcGet<AutoUpdateGet>(server, "autoupdate.get").then((c) => c.lastRunAt),
      ).toBeNull();

      const before = Date.now();
      const stamped = await trpcPost<AutoUpdateConfig>(server, "autoupdate.stampRun");
      const after = Date.now();
      expect(stamped.lastRunAt).not.toBeNull();
      const stampedMs = new Date(stamped.lastRunAt as string).getTime();
      expect(stampedMs).toBeGreaterThanOrEqual(before);
      expect(stampedMs).toBeLessThanOrEqual(after);

      // Persisted — a fresh read sees the same stamp.
      const reread = await trpcGet<AutoUpdateGet>(server, "autoupdate.get");
      expect(reread.lastRunAt).toBe(stamped.lastRunAt);
    } finally {
      await server.stop();
    }
  });
});
