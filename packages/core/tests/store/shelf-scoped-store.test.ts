// Shelf-scoped store handle (spec 062 T3 / SC 3 + SC 6, store half). A two-shelf router
// (`members/x/` writable, `team/` read-only) proves the load-bearing mechanism: writes through a
// shelf-scoped handle land BENEATH that shelf's prefix (memory/handoff/reference/inbox), the
// `routeMemoryWrite` landing verdict is untouched within the shelf, a read-only shelf refuses
// writes with the typed error, and the git repo + sidecars stay SINGULAR — every mutation flows
// through the one commit closure into the one repo, with no per-shelf `.git` or sidecars.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type Principal,
  type Shelf,
  type VaultRouter,
  ShelfNotInWriteSetError,
  ShelfNotWritableError,
  createLibrarianStore,
} from "@librarian/core";
import { afterEach, describe, expect, it } from "vitest";

// ── deterministic injections (spec 062 SC 1 plumbing, reused here) ──────────────
function steppingClock(): () => string {
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  let tick = 0;
  return () => new Date(base + tick++ * 60_000).toISOString();
}
function sequentialIds(): () => string {
  let n = 0;
  return () => `gid-${String(++n).padStart(4, "0")}`;
}

const MEMBERS_X: Shelf = {
  id: "members-x",
  prefix: "members/x/",
  writable: true,
  label: "Sarah's shelf",
};
const TEAM: Shelf = { id: "team", prefix: "team/", writable: false, label: "Team" };

// A two-shelf router: writes go only to the personal shelf; recall/search span both, with the
// team shelf read-only. `writeTarget` is the personal (writable) shelf.
const twoShelfRouter: VaultRouter = {
  shelves: (_principal, op) => (op === "write" ? [MEMBERS_X] : [MEMBERS_X, TEAM]),
  writeTarget: () => MEMBERS_X,
};

const AGENT: Principal = {
  kind: "agent",
  actorId: "sarah",
  boundActorId: "sarah",
  roles: ["agent"],
};

const HANDOFF_DOCUMENT = [
  "## Start & intent",
  "Pick up the migration.",
  "",
  "## Journey",
  "Mapped the claims.",
  "",
  "## Current state",
  "Compiles.",
  "",
  "## What's left",
  "Cut over staging.",
  "",
  "## Open questions",
  "Keep the legacy cookie?",
].join("\n");

const dataDirs: string[] = [];
const stores: LibrarianStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      /* ignore */
    }
  }
  for (const dir of dataDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function freshStore(router?: VaultRouter): {
  store: LibrarianStore;
  dataDir: string;
  vault: string;
} {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-shelf-"));
  dataDirs.push(dataDir);
  const store = createLibrarianStore({
    dataDir,
    now: steppingClock(),
    generateId: sequentialIds(),
    ...(router ? { vaultRouter: router } : {}),
  });
  stores.push(store);
  return { store, dataDir, vault: path.join(dataDir, "vault") };
}

function read(vault: string, rel: string): string {
  return fs.readFileSync(path.join(vault, rel), "utf8");
}
function gitLog(vault: string): string[] {
  return execFileSync("git", ["-C", vault, "log", "--pretty=%s"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
}

describe("shelf-scoped store handle — writes land beneath the shelf prefix (spec 062 SC 3)", () => {
  it("memory / handoff / reference / inbox all resolve under members/x/, with correct frontmatter", () => {
    const { store, vault } = freshStore(twoShelfRouter);
    const shelf = store.forShelf(MEMBERS_X);

    const { memory } = shelf.createMemory(
      {
        title: "Deploy runbook",
        body: "Roll back with plat rollback.",
        agent_id: "sarah",
        tags: ["ops"],
      },
      {},
    );
    shelf.handoffs.store(
      { title: "Migration handoff", document_md: HANDOFF_DOCUMENT, project_key: "platform" },
      { created_by_agent_id: "sarah" },
    );
    // The vault-file surface speaks FULL vault-relative paths + the shelf prefix (T2 design).
    shelf.vaultFiles.createFile("members/x/references/web/oauth.md", "# OAuth\n\nsource\n");
    const inboxRef = shelf.submitToInbox("Sarah now leads platform.");

    // Every write landed BENEATH members/x/ — none at the vault root.
    const memFiles = fs
      .readdirSync(path.join(vault, "members/x/memories"))
      .filter((f) => f.endsWith(".md"));
    expect(memFiles).toHaveLength(1);
    const memRaw = read(vault, `members/x/memories/${memFiles[0]}`);
    expect(memRaw).toMatch(/^id: gid-0001$/m); // injected id — determinism plumbing
    expect(memRaw).toMatch(/^agent_id: sarah$/m);
    expect(memRaw).toMatch(/^status: active$/m);
    expect(memRaw).toMatch(/^created_at: '2026-01-01T00:00:00.000Z'$/m);

    const hdoFiles = fs
      .readdirSync(path.join(vault, "members/x/handoffs"))
      .filter((f) => f.endsWith(".md"));
    expect(hdoFiles).toHaveLength(1);
    expect(read(vault, `members/x/handoffs/${hdoFiles[0]}`)).toMatch(/## Start & intent/);

    expect(fs.existsSync(path.join(vault, "members/x/references/web/oauth.md"))).toBe(true);
    // The handle returns a SHELF-RELATIVE inbox path (`inbox/<ts>-<id>.md`) that lands under the
    // shelf prefix on disk.
    expect(inboxRef.relPath.startsWith("inbox/")).toBe(true);
    expect(fs.existsSync(path.join(vault, "members/x", inboxRef.relPath))).toBe(true);

    // The vault ROOT has no top-level memories/handoffs/references/inbox — the writes were scoped.
    expect(fs.existsSync(path.join(vault, "memories"))).toBe(false);
    expect(fs.existsSync(path.join(vault, "handoffs"))).toBe(false);
    expect(fs.existsSync(path.join(vault, "references"))).toBe(false);
    expect(fs.existsSync(path.join(vault, "inbox"))).toBe(false);

    // The scoped handle reads its own shelf; the top-level (root) store does NOT see the memory.
    expect(shelf.getMemory(memory.id)?.id).toBe(memory.id);
    expect(store.getMemory(memory.id)).toBeNull();
    expect(store.listAll({})).toHaveLength(0);
  });

  it("git is SINGULAR: one repo, the one commit closure committed every shelf write; no per-shelf sidecars", () => {
    const { store, dataDir, vault } = freshStore(twoShelfRouter);
    const shelf = store.forShelf(MEMBERS_X);
    shelf.createMemory({ title: "M", body: "B", agent_id: "sarah" }, {});
    shelf.handoffs.store(
      { title: "Handoff title", document_md: HANDOFF_DOCUMENT },
      { created_by_agent_id: "sarah" },
    );
    shelf.vaultFiles.createFile("members/x/references/r.md", "ref\n");
    shelf.submitToInbox("note");

    // ONE .git, at the vault root only — no per-shelf repo.
    expect(fs.existsSync(path.join(vault, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(vault, "members/x/.git"))).toBe(false);
    expect(fs.existsSync(path.join(vault, "members/.git"))).toBe(false);

    // Every write is a commit in the ONE repo (subjects from the shared commit closure). The
    // vault-file commit carries the FULL vault-relative path.
    const subjects = gitLog(vault);
    expect(subjects.some((s) => s.startsWith("memory: store"))).toBe(true);
    expect(subjects.some((s) => s.startsWith("handoff: store"))).toBe(true);
    expect(subjects).toContain("vault: create members/x/references/r.md");
    expect(subjects.some((s) => s.startsWith("inbox: submit"))).toBe(true);

    // The vault's top level holds ONLY .git + the shelf dir — no sidecar files leaked into the
    // repo, and no per-shelf sidecars. Sidecars live in dataDir, outside the vault.
    expect(fs.readdirSync(vault).sort()).toEqual([".git", "members"]);
    expect(fs.existsSync(path.join(vault, "members/x/settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(vault, "members/x/embeddings-cache"))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "vault"))).toBe(true);
  });

  it("routeMemoryWrite's verdict is untouched within the shelf: requires_approval → proposed", () => {
    const { store, vault } = freshStore(twoShelfRouter);
    const shelf = store.forShelf(MEMBERS_X);
    const { status } = shelf.createMemory(
      { title: "Protected", body: "needs review", agent_id: "sarah" },
      { requires_approval: true },
    );
    expect(status).toBe("proposed");
    const memFile = fs
      .readdirSync(path.join(vault, "members/x/memories"))
      .find((f) => f.endsWith(".md"))!;
    expect(read(vault, `members/x/memories/${memFile}`)).toMatch(/^status: proposed$/m);
  });
});

describe("shelf-scoped store handle — read-only shelf refuses writes (spec 062 SC 6)", () => {
  it("a scoped-handle write on a read-only shelf throws ShelfNotWritableError; reads still work", () => {
    const { store } = freshStore(twoShelfRouter);
    const team = store.forShelf(TEAM);
    expect(() => team.createMemory({ title: "x", body: "y" }, {})).toThrow(ShelfNotWritableError);
    expect(() => team.submitToInbox("x")).toThrow(ShelfNotWritableError);
    expect(() =>
      team.handoffs.store(
        { title: "t", document_md: HANDOFF_DOCUMENT },
        { created_by_agent_id: "a" },
      ),
    ).toThrow(ShelfNotWritableError);
    expect(() => team.vaultFiles.createFile("team/references/r.md", "x")).toThrow(
      ShelfNotWritableError,
    );
    // Reads are allowed on a read-only shelf (recall from the team shelf is T5).
    expect(team.getMemory("nope")).toBeNull();
    expect(team.listAll({})).toHaveLength(0);
  });
});

describe("shelf-scoped store handle — the write gate is PER CALL, not baked at first materialisation (spec 062 review A2)", () => {
  // The A2 defect: the gate was baked into the memoized handle at first build, so whichever caller
  // materialised a prefix FIRST fixed its writability process-wide. The gate is now derived per call
  // from the `shelf` argument, over one memoized core — so the SAME prefix serves an honest writable
  // and read-only view regardless of order.
  const writableTeam: Shelf = { id: "team", prefix: "team/", writable: true, label: "Team" };

  it("a WRITABLE view writes even after the prefix was first materialised READ-ONLY", () => {
    const { store, vault } = freshStore(twoShelfRouter);
    // Materialise team/ READ-ONLY first (a member's read-only recall/seed view). This used to bake a
    // read-only gate for the whole prefix.
    expect(() => store.forShelf(TEAM).createMemory({ title: "NOPE", body: "x" }, {})).toThrow(
      ShelfNotWritableError,
    );
    // A WRITABLE view of the SAME prefix now writes fine — the earlier read-only view baked nothing.
    store.forShelf(writableTeam).createMemory({ title: "SEED", body: "b", agent_id: "sarah" }, {});
    expect(
      fs.readdirSync(path.join(vault, "team/memories")).filter((f) => f.endsWith(".md")),
    ).toHaveLength(1);
  });

  it("a READ-ONLY view refuses a principal write even after the prefix was first materialised WRITABLE", () => {
    const { store, vault } = freshStore(twoShelfRouter);
    // Materialise team/ WRITABLE first (out-of-band seeding, as the Teams e2e does).
    store.forShelf(writableTeam).createMemory({ title: "SEED", body: "b", agent_id: "sarah" }, {});
    // A READ-ONLY view of the SAME prefix now REFUSES the principal write — the writable-first
    // materialisation did not neuter the gate (the inverse of the T7 e2e's seeding hazard).
    expect(() => store.forShelf(TEAM).createMemory({ title: "NOPE", body: "x" }, {})).toThrow(
      ShelfNotWritableError,
    );
    // Nothing new landed; the read-only view still SERVES reads over the shared core.
    expect(
      fs.readdirSync(path.join(vault, "team/memories")).filter((f) => f.endsWith(".md")),
    ).toHaveLength(1);
    expect(store.forShelf(TEAM).listAll({})).toHaveLength(1);
  });

  it("forShelf({ prefix: '', writable: false }) gates the MAIN core — the ignored root-read-only case (review A2 consequence ii)", () => {
    const { store, vault } = freshStore(); // default router; the top-level surface is writable
    store.createMemory({ title: "ROOT-SEED", body: "r", agent_id: "a" });
    const readOnlyRoot: Shelf = { id: "main", prefix: "", writable: false };
    // A read-only VIEW of the root core refuses writes (previously ignored — the baked writable gate
    // won), but still serves reads over the same core the top-level store uses.
    expect(() =>
      store.forShelf(readOnlyRoot).createMemory({ title: "NOPE", body: "x" }, {}),
    ).toThrow(ShelfNotWritableError);
    expect(store.forShelf(readOnlyRoot).listAll({})).toHaveLength(1);
    expect(
      fs.readdirSync(path.join(vault, "memories")).filter((f) => f.endsWith(".md")),
    ).toHaveLength(1); // nothing new landed
  });
});

describe("resolveWriteTarget — write-routing validation (spec 062 SC 6)", () => {
  it("default router resolves to the writable main shelf (byte-identical)", () => {
    const { store } = freshStore(); // default router
    const target = store.resolveWriteTarget(AGENT);
    expect(target.prefix).toBe("");
    expect(target.writable).toBe(true);
    // forShelf on the default target is the top-level path: it wraps the ONE memoized main core (the
    // gate view is per-call, review A2 — no longer a shared reference), so a write through it is
    // visible to the top-level store, and it lands at the vault ROOT.
    const { memory } = store
      .forShelf(target)
      .createMemory({ title: "T", body: "B", agent_id: "a" }, {});
    expect(store.getMemory(memory.id)?.id).toBe(memory.id);
  });

  it("a non-writable writeTarget throws ShelfNotWritableError", () => {
    const router: VaultRouter = {
      shelves: () => [MEMBERS_X, TEAM],
      writeTarget: () => TEAM, // read-only
    };
    const { store } = freshStore(router);
    expect(() => store.resolveWriteTarget(AGENT)).toThrow(ShelfNotWritableError);
  });

  it("a writeTarget outside shelves(principal, 'write') throws ShelfNotInWriteSetError", () => {
    const other: Shelf = { id: "other", prefix: "other/", writable: true };
    const router: VaultRouter = {
      shelves: (_p, op) => (op === "write" ? [MEMBERS_X] : [MEMBERS_X, TEAM]),
      writeTarget: () => other, // writable, but not in the write set
    };
    const { store } = freshStore(router);
    expect(() => store.resolveWriteTarget(AGENT)).toThrow(ShelfNotInWriteSetError);
  });

  it("a malformed supplied shelf set is caught at the runtime validation point", () => {
    // Nested prefixes violate the disjointness rule — validateShelfSet must fire when the store
    // materialises the set (spec 062 T1's runtime validation point).
    const router: VaultRouter = {
      shelves: () => [
        { id: "a", prefix: "team/", writable: true },
        { id: "b", prefix: "team/sub/", writable: true },
      ],
      writeTarget: () => ({ id: "a", prefix: "team/", writable: true }),
    };
    const { store } = freshStore(router);
    expect(() => store.resolveWriteTarget(AGENT)).toThrow(/disjoint|nested/i);
  });
});
