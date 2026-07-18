import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type Principal,
  type RefusalRecord,
  createInertBootstrapClaimHandle,
  createLibrarianStore,
} from "@librarian/core";
import { appRouter, createCallerFactory } from "@librarian/mcp-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TrpcContext } from "../../dist/trpc/context.js";

const createCaller = createCallerFactory(appRouter);

const ADMIN: Principal = {
  kind: "admin",
  actorId: "dashboard-admin",
  roles: ["admin"],
  tokenId: "tok-admin",
};
const MEMBER: Principal = {
  kind: "member",
  actorId: "member:alice",
  roles: ["member"],
  tokenId: "tok-member",
};
const ANONYMOUS: Principal = {
  kind: "agent",
  actorId: "anonymous",
  roles: [],
};

let dataDir = "";
let store: LibrarianStore;

function contextFor(principal: Principal): TrpcContext {
  return {
    principal,
    role: principal.roles.includes("admin") ? "admin" : "anonymous",
    store,
    secretKey: null,
    adminToken: "",
    bootstrapClaim: createInertBootstrapClaimHandle(),
  };
}

function denial(
  ts: string,
  kind: "bearer-invalid" | "origin-blocked",
  marker: string,
): RefusalRecord {
  return {
    v: 1,
    ts,
    kind,
    surface: "public",
    outcome: kind === "origin-blocked" ? 403 : 401,
    path: marker,
  };
}

function dropped(ts: string, count: number): RefusalRecord {
  return {
    v: 1,
    ts,
    kind: "dropped",
    count,
    windowStart: "2026-07-18T12:00:00.000Z",
  };
}

function writeGeneration(suffix: "" | ".1", rows: RefusalRecord[]): void {
  fs.writeFileSync(
    path.join(dataDir, `refusal-log.ndjson${suffix}`),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    { mode: 0o600 },
  );
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-refusal-reader-"));
  store = createLibrarianStore({ dataDir, refusalLog: { armed: true } });
});

afterEach(() => {
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("activity.refusals", () => {
  it("admits only admins and records member and anonymous attempts against the procedure", async () => {
    await expect(createCaller(contextFor(MEMBER)).activity.refusals()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(createCaller(contextFor(ANONYMOUS)).activity.refusals()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });

    const page = await createCaller(contextFor(ADMIN)).activity.refusals();
    expect(page.rows).toEqual([
      expect.objectContaining({
        kind: "trpc-unauthorized",
        procedure: "activity.refusals",
        actorId: "anonymous",
        roles: [],
      }),
      expect.objectContaining({
        kind: "trpc-unauthorized",
        procedure: "activity.refusals",
        actorId: "member:alice",
        roles: ["member"],
        tokenId: "tok-member",
      }),
    ]);
  });

  it("paginates newest-first across both generations and applies kind before offset", async () => {
    writeGeneration(".1", [
      denial("2026-07-18T12:00:00.000Z", "bearer-invalid", "/oldest"),
      denial("2026-07-18T12:00:01.000Z", "origin-blocked", "/prior"),
    ]);
    writeGeneration("", [
      denial("2026-07-18T12:00:02.000Z", "bearer-invalid", "/middle"),
      denial("2026-07-18T12:00:03.000Z", "bearer-invalid", "/newest"),
    ]);
    const caller = createCaller(contextFor(ADMIN));

    const page = await caller.activity.refusals({ limit: 3, offset: 1 });
    expect(page.total).toBe(4);
    expect(page.rows.map((row) => ("path" in row ? row.path : undefined))).toEqual([
      "/middle",
      "/prior",
      "/oldest",
    ]);

    const filtered = await caller.activity.refusals({
      kind: "bearer-invalid",
      limit: 1,
      offset: 1,
    });
    expect(filtered.total).toBe(3);
    expect(filtered.rows).toEqual([expect.objectContaining({ path: "/middle" })]);
  });

  it("filters dropped rows and sums their counts in the returned range", async () => {
    writeGeneration(".1", [dropped("2026-07-18T12:00:00.000Z", 2)]);
    writeGeneration("", [
      denial("2026-07-18T12:00:01.000Z", "bearer-invalid", "/between"),
      dropped("2026-07-18T12:00:02.000Z", 4),
    ]);

    const page = await createCaller(contextFor(ADMIN)).activity.refusals({
      kind: "dropped",
      limit: 10,
    });
    expect(page).toMatchObject({ total: 2, dropped: 6 });
    expect(page.rows.map((row) => (row.kind === "dropped" ? row.count : 0))).toEqual([4, 2]);
  });

  it("returns an empty page for corrupt generations", async () => {
    fs.writeFileSync(path.join(dataDir, "refusal-log.ndjson.1"), "{not-json}\n", {
      mode: 0o600,
    });
    fs.writeFileSync(
      path.join(dataDir, "refusal-log.ndjson"),
      '{"v":1,"ts":"2026-07-18T12:00:00.000Z","kind":"unknown"}\n',
      { mode: 0o600 },
    );

    await expect(createCaller(contextFor(ADMIN)).activity.refusals()).resolves.toEqual({
      rows: [],
      total: 0,
      dropped: 0,
    });
  });
});
