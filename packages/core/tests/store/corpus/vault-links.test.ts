// Vault link index tests (rethink T18, spec §8 / D15): wikilink target
// resolution by filename stem / frontmatter id / title / alias, and the
// backlinks ("what links here") lookup the explorer's backlinks pane renders.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Vault, buildVaultLinkIndex, createVault } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir: string;
let vault: Vault;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-vault-links-"));
  vault = createVault({ dataDir });
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const memoryDoc = (opts: { id: string; title: string; aliases?: string[]; body: string }): string =>
  [
    "---",
    `id: "${opts.id}"`,
    `title: "${opts.title}"`,
    ...(opts.aliases?.length
      ? ["aliases:", ...opts.aliases.map((a) => `  - "${a}"`)]
      : ["aliases: []"]),
    "---",
    "",
    opts.body,
    "",
  ].join("\n");

describe("buildVaultLinkIndex", () => {
  it("resolves a wikilink target by filename stem, frontmatter id, title, and alias", () => {
    vault.writeText(
      "memories/elaine-piano-1234abcd.md",
      memoryDoc({
        id: "mem_1234abcd",
        title: "Elaine — Piano Teacher",
        aliases: ["Elaine"],
        body: "Lessons on Tuesdays.",
      }),
    );

    const index = buildVaultLinkIndex(vault);
    expect(index.resolve("elaine-piano-1234abcd")).toBe("memories/elaine-piano-1234abcd.md");
    expect(index.resolve("mem_1234abcd")).toBe("memories/elaine-piano-1234abcd.md");
    expect(index.resolve("Elaine — Piano Teacher")).toBe("memories/elaine-piano-1234abcd.md");
    expect(index.resolve("Elaine")).toBe("memories/elaine-piano-1234abcd.md");
    // Case-insensitive, like Obsidian.
    expect(index.resolve("elaine — piano teacher")).toBe("memories/elaine-piano-1234abcd.md");
    expect(index.resolve("no-such-doc")).toBeNull();
  });

  it("returns the paths that wikilink to a file as its backlinks", () => {
    vault.writeText(
      "memories/elaine-1.md",
      memoryDoc({ id: "mem_1", title: "Elaine", body: "Plays piano." }),
    );
    vault.writeText(
      "memories/lessons-2.md",
      memoryDoc({ id: "mem_2", title: "Lessons", body: "Weekly with [[Elaine]] at home." }),
    );
    vault.writeText(
      "memories/unrelated-3.md",
      memoryDoc({ id: "mem_3", title: "Unrelated", body: "No links here." }),
    );
    // References participate too — any vault markdown can link.
    vault.writeText("references/schedule.md", "See [[mem_1]] for the teacher.\n");

    const backlinks = buildVaultLinkIndex(vault).backlinks("memories/elaine-1.md");
    expect(backlinks).toEqual(["memories/lessons-2.md", "references/schedule.md"]);
  });

  it("a self-link is not a backlink, and alias/heading link forms still count", () => {
    vault.writeText(
      "memories/elaine-1.md",
      memoryDoc({ id: "mem_1", title: "Elaine", body: "Recursive [[Elaine]] mention." }),
    );
    vault.writeText(
      "memories/notes-2.md",
      memoryDoc({ id: "mem_2", title: "Notes", body: "See [[Elaine#Schedule|her schedule]]." }),
    );

    const index = buildVaultLinkIndex(vault);
    expect(index.backlinks("memories/elaine-1.md")).toEqual(["memories/notes-2.md"]);
  });

  it("lists a file's outbound links with their resolution (null = dangling)", () => {
    vault.writeText(
      "memories/elaine-1.md",
      memoryDoc({ id: "mem_1", title: "Elaine", body: "Linked from elsewhere." }),
    );
    vault.writeText(
      "memories/notes-2.md",
      memoryDoc({ id: "mem_2", title: "Notes", body: "[[Elaine]] and [[Ghost Doc]]." }),
    );

    const outbound = buildVaultLinkIndex(vault).outbound("memories/notes-2.md");
    expect(outbound).toEqual([
      { target: "Elaine", path: "memories/elaine-1.md" },
      { target: "Ghost Doc", path: null },
    ]);
  });

  it("a file with malformed frontmatter is still addressable by its stem", () => {
    vault.writeText("references/broken.md", "---\n: not yaml [\n---\nBody with [[elaine-1]].\n");
    vault.writeText(
      "memories/elaine-1.md",
      memoryDoc({ id: "mem_1", title: "Elaine", body: "Target." }),
    );

    const index = buildVaultLinkIndex(vault);
    expect(index.resolve("broken")).toBe("references/broken.md");
    expect(index.backlinks("memories/elaine-1.md")).toEqual(["references/broken.md"]);
  });

  it("honours the include filter (hidden files neither resolve nor backlink)", () => {
    vault.writeText("inbox/item-1.md", "Links [[Elaine]].\n");
    vault.writeText(
      "memories/elaine-1.md",
      memoryDoc({ id: "mem_1", title: "Elaine", body: "Target." }),
    );

    const index = buildVaultLinkIndex(vault, {
      include: (relPath) => !relPath.startsWith("inbox/"),
    });
    expect(index.resolve("item-1")).toBeNull();
    expect(index.backlinks("memories/elaine-1.md")).toEqual([]);
  });
});
