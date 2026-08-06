import { createLibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

interface TrpcOk<T> {
  result: { data: T };
}

interface ServerHandle {
  url: string;
  trpcUrl: string;
  token: string;
  stop: () => Promise<void>;
}

async function trpcGet<T>(server: ServerHandle, path: string, input?: unknown): Promise<T> {
  const url = new URL(`${server.trpcUrl}/trpc/${path}`);
  if (input !== undefined) url.searchParams.set("input", JSON.stringify(input));
  const response = await fetch(url, { headers: { authorization: `Bearer ${server.token}` } });
  const json = (await response.json()) as TrpcOk<T> | { error: unknown };
  if (!response.ok || "error" in json) throw new Error(JSON.stringify(json));
  return json.result.data;
}

async function trpcPost<T>(server: ServerHandle, path: string, input?: unknown): Promise<T> {
  const response = await fetch(`${server.trpcUrl}/trpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const json = (await response.json()) as TrpcOk<T> | { error: unknown };
  if (!response.ok || "error" in json) throw new Error(JSON.stringify(json));
  return json.result.data;
}

describe("tRPC Chronicle surface", () => {
  let dataDir = "";

  beforeEach(() => {
    dataDir = makeTempDir();
  });

  afterEach(() => {
    cleanupTempDir(dataDir);
  });

  it("is unreachable from the public listener", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      expect((await fetch(`${server.url}/trpc/chronicle.config`)).status).toBe(404);
      expect(
        (
          await fetch(`${server.url}/trpc/chronicle.runNow`, {
            method: "POST",
            headers: { "content-type": "application/json" },
          })
        ).status,
      ).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it("reads safe defaults and round-trips the weekly schedule", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      expect(await trpcGet(server, "chronicle.config")).toEqual({
        enabled: false,
        dayOfWeek: "monday",
        scheduleTime: "08:00",
      });

      expect(
        await trpcPost(server, "chronicle.setConfig", {
          enabled: true,
          dayOfWeek: "friday",
          scheduleTime: "17:30",
        }),
      ).toEqual({ enabled: true, dayOfWeek: "friday", scheduleTime: "17:30" });
    } finally {
      await server.stop();
    }
  });

  it("rejects an invalid schedule as caller input", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.trpcUrl}/trpc/chronicle.setConfig`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${server.token}`,
        },
        body: JSON.stringify({ scheduleTime: "25:00" }),
      });
      expect(response.status).toBe(400);
    } finally {
      await server.stop();
    }
  });

  it("lists filtered run history and runs a disabled Chronicle on admin demand", async () => {
    const seed = createLibrarianStore({ dataDir });
    const oldRun = seed.createChronicleRun({
      trigger: "schedule",
      shelf_id: "old-shelf",
      shelf_label: "Old",
      period_start: "2026-07-20",
      period_end: "2026-07-26",
      iso_week: "2026-W30",
      partial: false,
      model_provider: null,
      model_name: null,
    });
    seed.failChronicleRun(oldRun.id, { error: "write_failed", duration_ms: 4 });
    seed.close();

    const server = await startHttpServer({ dataDir });
    try {
      const failed = await trpcGet<Array<{ id: string; status: string }>>(
        server,
        "chronicle.runs",
        { status: "failed", limit: 10 },
      );
      expect(failed).toEqual([expect.objectContaining({ id: oldRun.id, status: "failed" })]);

      const result = await trpcPost<{
        ran: boolean;
        trigger: string;
        completed: number;
        digestOnly: number;
      }>(server, "chronicle.runNow");
      expect(result).toMatchObject({
        ran: true,
        trigger: "manual",
        completed: 1,
        digestOnly: 1,
      });

      const manual = await trpcGet<Array<{ trigger: string; path: string }>>(
        server,
        "chronicle.runs",
        { trigger: "manual" },
      );
      expect(manual).toEqual([
        expect.objectContaining({ trigger: "manual", path: expect.stringMatching(/chronicle/) }),
      ]);
    } finally {
      await server.stop();
    }
  });
});
