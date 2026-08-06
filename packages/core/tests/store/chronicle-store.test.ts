import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SHELF,
  ShelfNotWritableError,
  createLibrarianStore,
  type LibrarianStore,
  type Shelf,
} from "@librarian/core";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
const stores: LibrarianStore[] = [];

function boot(): { store: LibrarianStore; dataDir: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-chronicle-store-"));
  dirs.push(dataDir);
  const store = createLibrarianStore({ dataDir });
  stores.push(store);
  return { store, dataDir };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("LibrarianStore.systemWriteChronicle", () => {
  it("upserts one searchable reference with Chronicle provenance and leaves recall untouched", async () => {
    const { store, dataDir } = boot();

    const first = store.systemWriteChronicle(DEFAULT_SHELF, {
      isoWeek: "2026-W31",
      content: "# Chronicle\n\nThe albatross migration shipped.\n",
    });
    const second = store.systemWriteChronicle(DEFAULT_SHELF, {
      isoWeek: "2026-W31",
      content: "# Chronicle\n\nThe albatross migration shipped safely.\n",
    });

    expect(first.path).toBe("references/chronicle/2026-W31.md");
    expect(second.path).toBe(first.path);
    expect(fs.readFileSync(path.join(dataDir, "vault", first.path), "utf8")).toContain("safely");
    expect(store.vaultFiles.tree().filter((node) => node.name === "references")).toHaveLength(1);
    expect(store.vaultActivity()[0]).toMatchObject({
      subject: "chronicle: 2026-W31",
      source: "system",
      files: ["references/chronicle/2026-W31.md"],
    });
    expect(await store.searchReferences("albatross migration", 5)).toEqual([
      expect.objectContaining({ id: "references/chronicle/2026-W31.md" }),
    ]);
    expect(await store.recall({ query: "albatross migration" })).toEqual([]);
  });

  it("confines the write to a writable shelf and refuses a read-only shelf", () => {
    const { store, dataDir } = boot();
    const team: Shelf = { id: "team-a", prefix: "teams/a/", writable: true };
    const readOnly: Shelf = { id: "team-b", prefix: "teams/b/", writable: false };

    const written = store.systemWriteChronicle(team, {
      isoWeek: "2026-W31",
      content: "# Team A Chronicle\n",
    });

    expect(written.path).toBe("teams/a/references/chronicle/2026-W31.md");
    expect(fs.existsSync(path.join(dataDir, "vault", written.path))).toBe(true);
    expect(() =>
      store.systemWriteChronicle(readOnly, {
        isoWeek: "2026-W31",
        content: "# Must not land\n",
      }),
    ).toThrow(ShelfNotWritableError);
    expect(fs.existsSync(path.join(dataDir, "vault", "teams/b"))).toBe(false);
  });

  it("rejects a malformed week before touching the vault", () => {
    const { store, dataDir } = boot();

    expect(() =>
      store.systemWriteChronicle(DEFAULT_SHELF, {
        isoWeek: "../outside\nLibrarian-Actor: root",
        content: "# Nope\n",
      }),
    ).toThrow(/ISO week/);
    expect(fs.existsSync(path.join(dataDir, "vault", "references", "chronicle"))).toBe(false);
  });
});
