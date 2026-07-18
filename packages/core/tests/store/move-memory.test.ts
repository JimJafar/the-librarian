import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type Principal,
  type Shelf,
  type VaultRouter,
  MemoryAlreadyOnShelfError,
  MemoryMoveDestinationExistsError,
  MemoryNotFoundForPrincipalError,
  ShelfNotWritableError,
  commitSubject,
  createLibrarianStore,
  parseMemoryDocument,
  serializeMemoryDocument,
} from "@librarian/core";
import { afterEach, describe, expect, it } from "vitest";

const SOURCE: Shelf = { id: "personal", prefix: "members/alice/", writable: true };
const DESTINATION: Shelf = { id: "team", prefix: "team/", writable: true, label: "Team" };
const OFF_SET: Shelf = { id: "other", prefix: "members/bob/", writable: true };
const PRINCIPAL: Principal = { kind: "member", actorId: "member:alice", roles: ["member"] };

const dataDirs: string[] = [];
const stores: LibrarianStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dataDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function freshStore(
  shelves: readonly Shelf[] = [SOURCE, DESTINATION],
  builds?: string[],
): { store: LibrarianStore; vaultDir: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-memory-move-"));
  dataDirs.push(dataDir);
  const router: VaultRouter = {
    shelves: () => shelves,
    writeTarget: () => SOURCE,
  };
  const store = createLibrarianStore({
    dataDir,
    vaultRouter: router,
    ...(builds ? { onIndexBuild: (prefix) => builds.push(prefix) } : {}),
  });
  stores.push(store);
  return { store, vaultDir: path.join(dataDir, "vault") };
}

function memoryPath(vaultDir: string, shelf: Shelf, id: string): string {
  const memoriesDir = path.join(vaultDir, ...shelf.prefix.split("/").filter(Boolean), "memories");
  const name = fs.readdirSync(memoriesDir).find((entry) => {
    const raw = fs.readFileSync(path.join(memoriesDir, entry), "utf8");
    return parseMemoryDocument(raw).id === id;
  });
  if (!name) throw new Error(`fixture memory ${id} not found on ${shelf.id}`);
  return path.join(memoriesDir, name);
}

function writeMemory(vaultDir: string, shelf: Shelf, id: string): void {
  const dir = path.join(vaultDir, ...shelf.prefix.split("/").filter(Boolean), "memories");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.md`),
    serializeMemoryDocument({
      id,
      title: id,
      body: `body ${id}`,
      agent_id: "member:alice",
      confidence: "high",
      tags: [],
      applies_to: [],
      supersedes: [],
      conflicts_with: [],
      flags: [],
      status: "active",
      is_global: false,
      requires_approval: false,
      created_at: "2026-07-18T00:00:00.000Z",
      updated_at: "2026-07-18T00:00:00.000Z",
    }),
  );
}

describe("moveMemoryForPrincipal", () => {
  it("moves the same bytes and filename between prefixes while preserving the memory id", () => {
    const { store, vaultDir } = freshStore();
    const { memory } = store
      .forShelf(SOURCE)
      .createMemory(
        { title: "Promotion candidate", body: "keep these bytes", agent_id: PRINCIPAL.actorId },
        {},
      );
    const beforePath = memoryPath(vaultDir, SOURCE, memory.id);
    const before = fs.readFileSync(beforePath);

    const moved = store.moveMemoryForPrincipal(PRINCIPAL, memory.id, DESTINATION.id);

    const afterPath = memoryPath(vaultDir, DESTINATION, memory.id);
    expect(path.basename(afterPath)).toBe(path.basename(beforePath));
    expect(fs.existsSync(beforePath)).toBe(false);
    expect(fs.readFileSync(afterPath)).toEqual(before);
    expect(moved).toEqual(memory);
    expect(store.forShelf(DESTINATION).getMemory(memory.id)?.id).toBe(memory.id);
  });

  it("invalidates both shelves' corpus indexes", async () => {
    const builds: string[] = [];
    const { store } = freshStore([SOURCE, DESTINATION], builds);
    const { memory } = store
      .forShelf(SOURCE)
      .createMemory({ title: "Piano", body: "piano tuning", agent_id: PRINCIPAL.actorId }, {});
    store
      .forShelf(DESTINATION)
      .createMemory({ title: "Sailing", body: "open water", agent_id: PRINCIPAL.actorId }, {});
    await store.forShelf(SOURCE).recall({ query: "piano" });
    await store.forShelf(DESTINATION).recall({ query: "sailing" });

    store.moveMemoryForPrincipal(PRINCIPAL, memory.id, DESTINATION.id);
    await store.forShelf(SOURCE).recall({ query: "piano" });
    await store.forShelf(DESTINATION).recall({ query: "piano" });

    expect(builds).toEqual([SOURCE.prefix, DESTINATION.prefix, SOURCE.prefix, DESTINATION.prefix]);
  });

  it("uses an indistinguishable typed refusal for absent and off-set target ids", () => {
    const { store, vaultDir } = freshStore();
    writeMemory(vaultDir, OFF_SET, "mem_off_set");

    for (const id of ["mem_missing", "mem_off_set"]) {
      expect(() => store.moveMemoryForPrincipal(PRINCIPAL, id, DESTINATION.id)).toThrow(
        MemoryNotFoundForPrincipalError,
      );
      try {
        store.moveMemoryForPrincipal(PRINCIPAL, id, DESTINATION.id);
      } catch (error) {
        expect(error).toMatchObject({
          name: "MemoryNotFoundForPrincipalError",
          message: "memory or shelf was not found",
        });
      }
    }
  });

  it("uses the same no-oracle refusal for an unknown or off-set destination id", () => {
    const { store } = freshStore();
    const { memory } = store
      .forShelf(SOURCE)
      .createMemory({ title: "Move me", body: "body", agent_id: PRINCIPAL.actorId }, {});

    for (const shelfId of ["missing", OFF_SET.id]) {
      expect(() => store.moveMemoryForPrincipal(PRINCIPAL, memory.id, shelfId)).toThrow(
        MemoryNotFoundForPrincipalError,
      );
    }
  });

  it("refuses the source shelf itself by identity", () => {
    const { store } = freshStore();
    const { memory } = store
      .forShelf(SOURCE)
      .createMemory({ title: "Stay", body: "body", agent_id: PRINCIPAL.actorId }, {});

    expect(() => store.moveMemoryForPrincipal(PRINCIPAL, memory.id, SOURCE.id)).toThrow(
      MemoryAlreadyOnShelfError,
    );
  });

  it("never overwrites an occupied destination path", () => {
    const { store, vaultDir } = freshStore();
    const { memory } = store
      .forShelf(SOURCE)
      .createMemory({ title: "Collision", body: "source", agent_id: PRINCIPAL.actorId }, {});
    const sourcePath = memoryPath(vaultDir, SOURCE, memory.id);
    const destinationDir = path.join(vaultDir, DESTINATION.prefix, "memories");
    fs.mkdirSync(destinationDir, { recursive: true });
    const destinationPath = path.join(destinationDir, path.basename(sourcePath));
    fs.writeFileSync(destinationPath, "occupied");

    expect(() => store.moveMemoryForPrincipal(PRINCIPAL, memory.id, DESTINATION.id)).toThrow(
      MemoryMoveDestinationExistsError,
    );
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.readFileSync(destinationPath, "utf8")).toBe("occupied");
  });

  it("refuses a read-only source and a destination with no writable bearer", () => {
    const readOnlySource: Shelf = { ...SOURCE, writable: false };
    const readOnlyDestination: Shelf = { ...DESTINATION, writable: false };

    const sourceCase = freshStore([readOnlySource, DESTINATION]);
    writeMemory(sourceCase.vaultDir, readOnlySource, "mem_source_read_only");
    expect(() =>
      sourceCase.store.moveMemoryForPrincipal(PRINCIPAL, "mem_source_read_only", DESTINATION.id),
    ).toThrow(ShelfNotWritableError);

    const destinationCase = freshStore([SOURCE, readOnlyDestination]);
    const { memory } = destinationCase.store
      .forShelf(SOURCE)
      .createMemory({ title: "No bearer", body: "body", agent_id: PRINCIPAL.actorId }, {});
    expect(() =>
      destinationCase.store.moveMemoryForPrincipal(PRINCIPAL, memory.id, readOnlyDestination.id),
    ).toThrow(ShelfNotWritableError);
  });

  it("resolves a shared destination id to its unique writable bearer", () => {
    const sharedReadOnly: Shelf = { id: "shared", prefix: "shared-read/", writable: false };
    const sharedWritable: Shelf = { id: "shared", prefix: "shared-write/", writable: true };
    const { store, vaultDir } = freshStore([SOURCE, sharedReadOnly, sharedWritable]);
    const { memory } = store
      .forShelf(SOURCE)
      .createMemory({ title: "Shared target", body: "body", agent_id: PRINCIPAL.actorId }, {});

    store.moveMemoryForPrincipal(PRINCIPAL, memory.id, "shared");

    expect(memoryPath(vaultDir, sharedWritable, memory.id)).toBeTruthy();
    expect(fs.existsSync(path.join(vaultDir, sharedReadOnly.prefix, "memories"))).toBe(false);
  });

  it("does not mistake a same-id, different-prefix shelf for the source identity", () => {
    const sourceReadOnly: Shelf = { id: "shared", prefix: "shared-read/", writable: false };
    const destinationWritable: Shelf = { id: "shared", prefix: "shared-write/", writable: true };
    const { store, vaultDir } = freshStore([sourceReadOnly, destinationWritable]);
    writeMemory(vaultDir, sourceReadOnly, "mem_same_id");

    expect(() => store.moveMemoryForPrincipal(PRINCIPAL, "mem_same_id", "shared")).toThrow(
      ShelfNotWritableError,
    );
    expect(() => store.moveMemoryForPrincipal(PRINCIPAL, "mem_same_id", "shared")).not.toThrow(
      MemoryAlreadyOnShelfError,
    );
  });
});

describe("commitSubject.memoryMove", () => {
  it("uses shelf ids, strips newlines, and never includes paths or labels", () => {
    expect(commitSubject.memoryMove("mem_1\nforged", "personal\r\nx", "team\nx")).toBe(
      "memory: move mem_1forged (personalx -> teamx)",
    );
  });
});
