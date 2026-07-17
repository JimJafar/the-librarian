// The typed audit export (spec 064 T6–T8 / SC 8–12) — the read half of the attribution
// substrate. T6 pins the PERMANENT published record (the schema + error-class VALUES, the closed
// action union) and the read-side attribution defence SC 7c (a commit with ≠1 `Librarian-Actor`
// trailer exports `actor: null` — a forged/duplicated trailer is never believed). T7/T8 extend
// this file with the shelf filter, promotion records, pagination and diff bounds.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type AuditBuildContext,
  type AuditEvent,
  type Principal,
  type SyncGitOps,
  AUDIT_ACTIONS,
  AuditCursorError,
  AuditEventSchema,
  AuditSourceError,
  DEFAULT_SHELF,
  actionForSubject,
  buildAuditEvents,
  createGitHistory,
  createLibrarianStore,
  createSyncGitOps,
  subjectIdForSubject,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let cwd: string;
let git: SyncGitOps;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-audit-"));
  git = createSyncGitOps({ cwd });
  git.init();
});
afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

const write = (rel: string, content: string): void => {
  const abs = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
};

/** Craft a commit carrying EXACTLY `actors.length` `Librarian-Actor` trailers (0, 1, or a forged
 *  ≥2) — the raw path a sanitised `commitPaths` would never take, so SC 7c can be proven on read. */
function commitWithTrailers(rel: string, body: string, message: string, actors: string[]): void {
  write(rel, body);
  execFileSync("git", ["add", "--", rel], { cwd });
  execFileSync(
    "git",
    [
      "-c",
      "trailer.ifmissing=add",
      "commit",
      "-m",
      message,
      ...actors.flatMap((a) => ["--trailer", `Librarian-Actor=${a}`]),
    ],
    { cwd },
  );
}

/** A build context over the OSS default shelf (the whole vault), as an admin. */
function defaultCtx(overrides: Partial<AuditBuildContext> = {}): AuditBuildContext {
  return {
    shelves: [DEFAULT_SHELF],
    isAdmin: true,
    includeDiff: false,
    commitDiff: (hash) => ({ hash, files: [] }),
    ...overrides,
  };
}

const ADMIN: Principal = { kind: "admin", actorId: "dashboard-admin", roles: ["admin"] };

describe("the published record (spec 064 SC 8)", () => {
  it("AuditEventSchema validates a well-formed event and is strict about the surface", () => {
    const event: AuditEvent = {
      schemaVersion: 1,
      commit: "a".repeat(40),
      at: "2026-07-17T00:00:00Z",
      actor: "alice",
      channel: "agent",
      action: "memory.store",
      subjectId: "mem_1",
      shelves: ["main"],
    };
    expect(AuditEventSchema.parse(event)).toEqual(event);
    // Closed union: an off-vocabulary action is rejected (the surface is permanent).
    expect(AuditEventSchema.safeParse({ ...event, action: "memory.frobnicate" }).success).toBe(
      false,
    );
    // schemaVersion is pinned (a plugin pins its major on it).
    expect(AuditEventSchema.safeParse({ ...event, schemaVersion: 2 }).success).toBe(false);
    // Strict: an unexpected key on the permanent surface is a bug, not silently dropped.
    expect(AuditEventSchema.safeParse({ ...event, sneaky: true }).success).toBe(false);
  });

  it("publishes the error classes as VALUES (a plugin instanceof-checks them)", () => {
    expect(new AuditSourceError("boom")).toBeInstanceOf(Error);
    expect(new AuditCursorError("deadbeef")).toBeInstanceOf(Error);
    expect(new AuditSourceError("boom").name).toBe("AuditSourceError");
    expect(new AuditCursorError("deadbeef").name).toBe("AuditCursorError");
  });

  it("AuditAction is closed and 1:1 with the T1 vocabulary (no wildcards)", () => {
    // Spot-check the two distinctions v4 collapsed: a single-file revert is NOT a whole-vault
    // rollback, and the pre-rollback snapshot has its own name (not `other`).
    expect(actionForSubject("vault: restore memories/a.md to abc123def456")).toBe(
      "vault.restore-file",
    );
    expect(actionForSubject("vault: restore to abc123def456")).toBe("vault.rollback");
    expect(actionForSubject("vault: pre-restore snapshot")).toBe("vault.pre-rollback-snapshot");
    // Every subject family maps into the closed union; an unknown subject is `other`.
    expect(AUDIT_ACTIONS).toContain("shelf.departure");
    expect(actionForSubject("hand-made checkout commit")).toBe("other");
  });

  it("derives subjectId only for id-bearing subjects; vault/backup subjects carry none", () => {
    expect(subjectIdForSubject("memory: store mem_1", "memory.store")).toBe("mem_1");
    expect(subjectIdForSubject("memory: resolve mem_1 (applied_plan)", "memory.resolve")).toBe(
      "mem_1",
    );
    expect(subjectIdForSubject("inbox: submit inbox_42", "inbox.submit")).toBe("inbox_42");
    expect(subjectIdForSubject("vault: edit references/x.md", "vault.edit")).toBeNull();
    expect(subjectIdForSubject("backup: snapshot", "backup.snapshot")).toBeNull();
  });
});

describe("read-side attribution defence — ≠1 trailer → actor null (spec 064 SC 7c)", () => {
  it("believes a single trailer, disbelieves zero, and disbelieves a forged/duplicated pair", () => {
    commitWithTrailers("memories/a.md", "x\n", "memory: store mem_alice", ["alice"]);
    commitWithTrailers("memories/b.md", "y\n", "memory: store mem_none", []);
    // Two trailers — the exact shape a bypassed sanitiser or a hand-crafted commit would produce.
    commitWithTrailers("memories/c.md", "z\n", "memory: store mem_forged", ["realbot", "root"]);

    const read = createGitHistory({ cwd }).auditCommits();
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") throw new Error("expected ok");
    const bySubject = new Map(read.commits.map((c) => [c.subject, c]));

    const forged = bySubject.get("memory: store mem_forged")!;
    expect(forged.actors).toEqual(["realbot", "root"]);
    // A ≥2-trailer commit is NOT believed: actor null, never actors[0].
    expect(buildAuditEvents(forged, defaultCtx())[0]?.actor).toBeNull();

    const none = bySubject.get("memory: store mem_none")!;
    expect(none.actors).toEqual([]);
    expect(buildAuditEvents(none, defaultCtx())[0]?.actor).toBeNull();

    const alice = bySubject.get("memory: store mem_alice")!;
    expect(alice.actors).toEqual(["alice"]);
    const event = buildAuditEvents(alice, defaultCtx())[0]!;
    expect(event.actor).toBe("alice");
    expect(event.channel).toBe("agent");
    expect(event.action).toBe("memory.store");
    expect(event.subjectId).toBe("mem_alice");
  });

  it("an untrailered commit's channel falls back to the subject-based classifier (SC 5/6)", () => {
    // A whole-tree system sweep is untrailered → actor null, channel from the subject prefix.
    commitWithTrailers("memories/d.md", "d\n", "backup: snapshot", []);
    const read = createGitHistory({ cwd }).auditCommits();
    if (read.kind !== "ok") throw new Error("expected ok");
    const snap = read.commits.find((c) => c.subject === "backup: snapshot")!;
    const event = buildAuditEvents(snap, defaultCtx())[0]!;
    expect(event.actor).toBeNull();
    expect(event.channel).toBe("system"); // classifyVaultCommit("backup: snapshot")
    expect(event.action).toBe("backup.snapshot");
  });
});

describe("exportAudit end-to-end (spec 064 SC 8, default router)", () => {
  let dataDir: string;
  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("produces schema-valid, correctly-attributed events for an attributed write", () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-audit-store-"));
    const store = createLibrarianStore({ dataDir });
    try {
      store.createMemory({ title: "Rollout plan", body: "ship on green", agent_id: "alice" });
      const page = store.exportAudit(ADMIN);
      expect(page.hasMore).toBe(false);
      // Every event validates against the PUBLISHED schema.
      for (const event of page.events) AuditEventSchema.parse(event);
      const store_ = page.events.find((e) => e.action === "memory.store");
      expect(store_).toBeDefined();
      expect(store_?.actor).toBe("alice");
      expect(store_?.channel).toBe("agent");
      expect(store_?.subjectId).toMatch(/^mem_/);
      expect(store_?.shelves).toEqual(["main"]);
      // Admin sees the path (a filename encodes the title) — it is under memories/.
      expect(store_?.paths?.[0]).toMatch(/^memories\//);
    } finally {
      store.close();
    }
  });
});
