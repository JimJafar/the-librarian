import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RefusalDenialSchema,
  RefusalDroppedSchema,
  RefusalRecordSchema,
  createLibrarianStore,
} from "@librarian/core";
import { createRefusalLog } from "@librarian/core/store-internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const LOG_FILE = "refusal-log.ndjson";

let dataDir = "";
let originalSwitch: string | undefined;

const denial = {
  kind: "bearer-invalid",
  surface: "public",
  outcome: 401,
  path: "/mcp",
  tokenHash: "0123456789ab",
} as const;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-refusal-log-"));
  originalSwitch = process.env.LIBRARIAN_REFUSAL_LOG;
  delete process.env.LIBRARIAN_REFUSAL_LOG;
});

afterEach(() => {
  if (originalSwitch === undefined) {
    delete process.env.LIBRARIAN_REFUSAL_LOG;
  } else {
    process.env.LIBRARIAN_REFUSAL_LOG = originalSwitch;
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("refusal record schema", () => {
  it("accepts the two strict, disjoint record variants", () => {
    const refusal = {
      v: 1,
      ts: "2026-07-18T12:00:00.000Z",
      ...denial,
    } as const;
    const dropped = {
      v: 1,
      ts: "2026-07-18T12:00:01.000Z",
      kind: "dropped",
      count: 7,
      windowStart: "2026-07-18T12:00:00.000Z",
    } as const;

    expect(RefusalDenialSchema.parse(refusal)).toEqual(refusal);
    expect(RefusalDroppedSchema.parse(dropped)).toEqual(dropped);
    expect(RefusalRecordSchema.parse(refusal)).toEqual(refusal);
    expect(RefusalRecordSchema.parse(dropped)).toEqual(dropped);

    expect(RefusalRecordSchema.safeParse({ ...refusal, bearer: "must-not-fit" }).success).toBe(
      false,
    );
    expect(RefusalRecordSchema.safeParse({ ...dropped, outcome: 429 }).success).toBe(false);
    expect(RefusalRecordSchema.safeParse({ ...refusal, kind: "unknown-refusal" }).success).toBe(
      false,
    );
    expect(RefusalRecordSchema.safeParse({ ...refusal, tokenHash: "not-a-hash" }).success).toBe(
      false,
    );
    expect(RefusalRecordSchema.safeParse({ ...refusal, path: `/${"x".repeat(512)}` }).success).toBe(
      false,
    );
  });
});

describe("bounded refusal log", () => {
  it("round-trips denial and counted-drop rows newest-first with 0600 permissions", async () => {
    let nowMs = Date.parse("2026-07-18T12:00:00.000Z");
    const log = createRefusalLog({
      filePath: path.join(dataDir, LOG_FILE),
      armed: true,
      now: () => new Date(nowMs),
      bucketCapacity: 2,
      bucketRefillPerSecond: 2,
    });

    await log.record(denial);
    await log.record({ ...denial, kind: "bearer-missing" });
    await log.record({ ...denial, kind: "origin-blocked", outcome: 403 });
    await log.record({ ...denial, kind: "rate-limited", outcome: 429 });

    nowMs += 1_000;
    await log.record({ ...denial, kind: "bearer-wrong-scope", outcome: 403 });

    const result = await log.read({ limit: 20 });
    expect(result.rows.map((row) => row.kind)).toEqual([
      "bearer-wrong-scope",
      "dropped",
      "bearer-missing",
      "bearer-invalid",
    ]);
    expect(result.rows[1]).toMatchObject({
      kind: "dropped",
      count: 2,
      windowStart: "2026-07-18T12:00:00.000Z",
    });
    expect(result).toMatchObject({ total: 4, dropped: 2 });
    expect(fs.statSync(path.join(dataDir, LOG_FILE)).mode & 0o777).toBe(0o600);
  });

  it("rotates before the boundary, replaces the old generation, and keeps at most two files", async () => {
    let tick = 0;
    const log = createRefusalLog({
      filePath: path.join(dataDir, LOG_FILE),
      armed: true,
      now: () => new Date(Date.UTC(2026, 6, 18, 12, 0, tick++)),
      maxBytes: 200,
    });

    await log.record({ ...denial, path: "/first" });
    await log.record({ ...denial, path: "/second" });
    await log.record({ ...denial, path: "/third" });

    const result = await log.read({ limit: 20 });
    expect(result.rows.map((row) => ("path" in row ? row.path : undefined))).toEqual([
      "/third",
      "/second",
    ]);
    expect(
      fs
        .readdirSync(dataDir)
        .filter((name) => name.startsWith(LOG_FILE))
        .sort(),
    ).toEqual([LOG_FILE, `${LOG_FILE}.1`]);
    expect(fs.readFileSync(`${path.join(dataDir, LOG_FILE)}.1`, "utf8")).not.toContain("/first");
  });

  it("skips a torn final line while preserving complete records", async () => {
    const log = createRefusalLog({
      filePath: path.join(dataDir, LOG_FILE),
      armed: true,
    });
    await log.record(denial);
    fs.appendFileSync(path.join(dataDir, LOG_FILE), '{"v":1,"ts":"torn');

    const result = await log.read({ limit: 20 });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject(denial);
  });

  it("repairs a torn final line before the next append so both complete records survive", async () => {
    const log = createRefusalLog({
      filePath: path.join(dataDir, LOG_FILE),
      armed: true,
    });
    await log.record({ ...denial, path: "/before-torn-tail" });
    fs.appendFileSync(path.join(dataDir, LOG_FILE), '{"v":1,"ts":"torn');

    await log.record({ ...denial, path: "/after-torn-tail" });

    const result = await log.read({ limit: 20 });
    expect(result.rows).toEqual([
      expect.objectContaining({ path: "/after-torn-tail" }),
      expect.objectContaining({ path: "/before-torn-tail" }),
    ]);
  });

  it("flushes a finite dropped burst when read without requiring a later refusal", async () => {
    const log = createRefusalLog({
      filePath: path.join(dataDir, LOG_FILE),
      armed: true,
      bucketCapacity: 1,
      bucketRefillPerSecond: 1,
    });
    await log.record({ ...denial, path: "/accepted" });
    await log.record({ ...denial, path: "/dropped" });

    const result = await log.read({ limit: 20 });

    expect(result.rows).toEqual([
      expect.objectContaining({
        kind: "dropped",
        count: 1,
      }),
      expect.objectContaining({ path: "/accepted" }),
    ]);
    expect(result.dropped).toBe(1);
  });

  it("bounds accepted disk work as well as token admission when callers do not await", async () => {
    const log = createRefusalLog({
      filePath: path.join(dataDir, LOG_FILE),
      armed: true,
      bucketCapacity: 100,
      bucketRefillPerSecond: 1,
      queueCapacity: 2,
    });

    await Promise.all(
      Array.from({ length: 10 }, (_value, index) =>
        log.record({ ...denial, path: `/burst-${index}` }),
      ),
    );

    const result = await log.read({ limit: 20 });
    expect(result.rows.filter((row) => row.kind !== "dropped")).toHaveLength(2);
    expect(result.rows).toContainEqual(expect.objectContaining({ kind: "dropped", count: 8 }));
  });

  it("redacts and bounds every caller-controlled string before persistence", async () => {
    const secretValue = ["super", "secret", "value", "123"].join("-");
    const hostile = `password = "${secretValue}"\u0000\u202e`;
    const log = createRefusalLog({
      filePath: path.join(dataDir, LOG_FILE),
      armed: true,
    });

    await log.record({
      kind: "provider-refused",
      surface: "public",
      outcome: 403,
      path: hostile,
      procedure: hostile,
      tool: hostile,
      username: hostile,
      actorId: hostile,
      roles: [hostile],
      tokenId: hostile,
      tokenHash: "0123456789ab",
      ip: hostile,
      forwardedFor: `198.51.100.7, ${hostile}`,
      origin: `https://example.test/?${hostile}`,
      detail: hostile,
      shelfId: hostile,
      shelfLabel: hostile,
    });

    const serialized = fs.readFileSync(path.join(dataDir, LOG_FILE), "utf8");
    expect(serialized).not.toContain(secretValue);
    expect(serialized).not.toContain("\\u0000");
    expect(serialized).not.toContain("\\u202e");

    const [row] = (await log.read()).rows;
    expect(row).toMatchObject({
      kind: "provider-refused",
      tokenHash: "0123456789ab",
      forwardedFor: "198.51.100.7",
      origin: "https://example.test",
    });
    expect(row).not.toHaveProperty("ip");
  });

  it("always resolves after sink failures and reports the first error once", async () => {
    fs.mkdirSync(path.join(dataDir, LOG_FILE));
    const onError = vi.fn();
    const log = createRefusalLog({
      filePath: path.join(dataDir, LOG_FILE),
      armed: true,
      onError,
    });

    await expect(log.record(denial)).resolves.toBeUndefined();
    await expect(log.record({ ...denial, kind: "bearer-missing" })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("keeps an unarmed store inert and never creates the file", async () => {
    const store = createLibrarianStore({ dataDir });

    await expect(store.recordRefusal(denial)).resolves.toBeUndefined();
    expect(await store.readRefusals()).toEqual({ rows: [], total: 0, dropped: 0 });
    expect(fs.existsSync(path.join(dataDir, LOG_FILE))).toBe(false);
  });

  it("honours LIBRARIAN_REFUSAL_LOG=false even when the store is armed", async () => {
    process.env.LIBRARIAN_REFUSAL_LOG = "false";
    const store = createLibrarianStore({
      dataDir,
      refusalLog: { armed: true },
    });

    await expect(store.recordRefusal(denial)).resolves.toBeUndefined();
    expect(await store.readRefusals()).toEqual({ rows: [], total: 0, dropped: 0 });
    expect(fs.existsSync(path.join(dataDir, LOG_FILE))).toBe(false);
  });
});
