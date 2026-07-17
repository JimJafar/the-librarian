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
  type AuditCommit,
  type AuditEvent,
  type Principal,
  type Shelf,
  type SyncGitOps,
  type VaultRouter,
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

// ── T7: shelf filtering, admin-only fields, promotion records (SC 9 / 9b / 10) ──

const SHELF_A: Shelf = { id: "members-x", prefix: "members/x/", writable: true };
const SHELF_B: Shelf = { id: "team", prefix: "team/", writable: true };

/** A build context scoped to `shelves`, as admin or member. */
function ctxFor(shelves: Shelf[], isAdmin: boolean, includeDiff = false): AuditBuildContext {
  return { shelves, isAdmin, includeDiff, commitDiff: (hash) => ({ hash, files: [] }) };
}

/** A cross-shelf rename commit (A → B) with a NON-ASCII filename — the SC 9b straddle. */
const CROSS_RENAME: AuditCommit = {
  hash: "a".repeat(40),
  date: "2026-07-17T00:00:00Z",
  subject: "vault: rename members/x/references/café.md -> team/references/café.md",
  files: ["team/references/café.md"], // bare post-rename = destination
  renames: [{ from: "members/x/references/café.md", to: "team/references/café.md" }],
  actors: ["dashboard-admin"],
};

describe("shelf filtering + escalation-free fields (spec 064 SC 9)", () => {
  it("drops a commit that touches none of the caller's shelves", () => {
    const shelfBOnly: AuditCommit = {
      hash: "b".repeat(40),
      date: "2026-07-17T00:00:00Z",
      subject: "memory: store mem_secret",
      files: ["team/memories/secret-mem_secret.md"],
      renames: [],
      actors: ["bob"],
    };
    expect(buildAuditEvents(shelfBOnly, ctxFor([SHELF_A], true))).toEqual([]);
  });

  it("gives a NON-admin only actor+action+subjectId+shelves+at — no filenames of any kind", () => {
    const memInA: AuditCommit = {
      hash: "c".repeat(40),
      date: "2026-07-17T00:00:00Z",
      subject: "memory: store mem_1",
      files: ["members/x/memories/plan-mem_1.md"],
      renames: [],
      actors: ["sarah"],
    };
    const [event] = buildAuditEvents(memInA, ctxFor([SHELF_A], false));
    expect(event).toMatchObject({
      actor: "sarah",
      action: "memory.store",
      subjectId: "mem_1",
      shelves: ["members-x"],
      at: "2026-07-17T00:00:00Z",
    });
    // A member sees NO filenames — the memory filename encodes its title.
    expect(event?.paths).toBeUndefined();
    expect(event?.renames).toBeUndefined();
    expect(event?.diff).toBeUndefined();
  });

  it("an admin scoped to shelf A sees no shelf-B subjectId/path/name/rename/bytes (SC 9)", () => {
    const admin = ctxFor([SHELF_A], true, true);
    const events = buildAuditEvents(CROSS_RENAME, admin);
    const serialized = JSON.stringify(events);
    // A cross-shelf rename FROM shelf A → a departure record, dest redacted.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "shelf.departure",
      subjectId: null,
      shelves: ["members-x"],
    });
    expect(events[0]?.renames).toEqual([{ from: "members/x/references/café.md", to: null }]);
    expect(events[0]?.paths).toEqual(["members/x/references/café.md"]);
    // Nothing about shelf B leaks — not its prefix, not its name.
    expect(serialized).not.toContain("team");
  });
});

describe("audit-evasion via non-ASCII filenames is closed (spec 064 SC 9b)", () => {
  it("a café.md straddle is read UNQUOTED and stays inside the shelf filter", () => {
    write("members/x/references/café.md", "seed content\n");
    git.commitPaths(["members/x/references/café.md"], "vault: create members/x/references/café.md");
    // A cross-shelf move: drop the source, recreate identical bytes under shelf B; git `-M` (which
    // auditCommits passes) detects it as an R100 rename.
    fs.rmSync(path.join(cwd, "members/x/references/café.md"));
    write("team/references/café.md", "seed content\n");
    execFileSync("git", ["-C", cwd, "add", "-A"]);
    execFileSync("git", [
      "-C",
      cwd,
      "commit",
      "-q",
      "-m",
      "vault: rename members/x/references/café.md -> team/references/café.md",
    ]);
    const read = createGitHistory({ cwd }).auditCommits();
    if (read.kind !== "ok") throw new Error("expected ok");
    const rename = read.commits.find((c) => c.subject.startsWith("vault: rename"))!;
    // core.quotePath=false → the path is the true UTF-8 filename, not `"…\303\251…"`.
    expect(rename.renames[0]?.from).toBe("members/x/references/café.md");
    // …so the shelf filter matches it: shelf A sees a departure, correctly attributed.
    const [event] = buildAuditEvents(rename, ctxFor([SHELF_A], true));
    expect(event?.action).toBe("shelf.departure");
    expect(event?.shelves).toEqual(["members-x"]);
  });
});

describe("promotion is visible on both sides, leaking neither (spec 064 SC 10)", () => {
  it("a caller who sees BOTH shelves gets a departure + arrival pair, each redacting the far side", () => {
    const events = buildAuditEvents(CROSS_RENAME, ctxFor([SHELF_A, SHELF_B], true));
    expect(events.map((e) => e.action)).toEqual(["shelf.departure", "shelf.arrival"]);
    const [departure, arrival] = events;
    // Departure lives on the SOURCE shelf, destination redacted.
    expect(departure).toMatchObject({ shelves: ["members-x"] });
    expect(departure?.renames).toEqual([{ from: "members/x/references/café.md", to: null }]);
    // Arrival lives on the DESTINATION shelf, source redacted.
    expect(arrival).toMatchObject({ shelves: ["team"] });
    expect(arrival?.renames).toEqual([{ from: null, to: "team/references/café.md" }]);
  });

  it("a plain in-shelf rename keeps both sides (no crossing)", () => {
    const inShelf: AuditCommit = {
      hash: "d".repeat(40),
      date: "2026-07-17T00:00:00Z",
      subject: "vault: rename members/x/references/a.md -> members/x/references/b.md",
      files: ["members/x/references/b.md"],
      renames: [{ from: "members/x/references/a.md", to: "members/x/references/b.md" }],
      actors: ["sarah"],
    };
    const [event] = buildAuditEvents(inShelf, ctxFor([SHELF_A], true));
    expect(event?.action).toBe("vault.rename");
    expect(event?.renames).toEqual([
      { from: "members/x/references/a.md", to: "members/x/references/b.md" },
    ]);
  });
});

describe("exportAudit gating end-to-end under a Teams router (spec 064 SC 9)", () => {
  let dataDir: string;
  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // The caller's recall scope is [A] for both principals below; only their ROLE differs, so the
  // shelf scope is identical and only the admin-only FIELDS change (SC 9).
  const router: VaultRouter = {
    shelves: (p) => (p.actorId === "wide" ? [SHELF_A, SHELF_B] : [SHELF_A]),
    writeTarget: () => SHELF_A,
  };
  const MEMBER_A: Principal = { kind: "agent", actorId: "member-a", roles: ["member"] };
  const ADMIN_A: Principal = { kind: "admin", actorId: "admin-a", roles: ["admin"] };

  it("drops a shelf-B memory for a shelf-A caller; gates paths by role", () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-audit-teams-"));
    const store = createLibrarianStore({ dataDir, vaultRouter: router });
    try {
      store.forShelf(SHELF_A).createMemory({ title: "A fact", body: "in A", agent_id: "sarah" });
      store.forShelf(SHELF_B).createMemory({ title: "B secret", body: "in B", agent_id: "bob" });

      // A shelf-A member: the shelf-B write is dropped, and no filenames appear.
      const member = store.exportAudit(MEMBER_A);
      expect(JSON.stringify(member.events)).not.toContain("team");
      const memberStore = member.events.find((e) => e.action === "memory.store");
      expect(memberStore?.shelves).toEqual(["members-x"]);
      expect(memberStore?.paths).toBeUndefined();

      // A shelf-A admin: same scope (no shelf B), but the path is visible.
      const admin = store.exportAudit(ADMIN_A);
      expect(JSON.stringify(admin.events)).not.toContain("team");
      const adminStore = admin.events.find((e) => e.action === "memory.store");
      expect(adminStore?.paths?.[0]).toMatch(/^members\/x\/memories\//);
    } finally {
      store.close();
    }
  });
});
