// Vault file view (rethink T18): rendered markdown with clickable wikilinks,
// the frontmatter property table, and the backlinks pane.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { VaultFile } from "@/components/vault/types";

const { FileView } = await import("@/components/vault/file-view");
const { MarkdownContent, rewriteWikilinks } = await import("@/components/vault/markdown-content");

const memoryFile: VaultFile = {
  path: "memories/anna-1.md",
  kind: "memory",
  raw: "---\nid: mem_1\n---\n\nLessons with [[Trash Over rm]] weekly.\n",
  body: "Lessons with [[Trash Over rm]] weekly.\n",
  frontmatter: { id: "mem_1", title: "Anna", tags: ["people", "music"], is_global: false },
  hash: "hash-1",
  mtime: "2026-06-12T00:00:00.000Z",
  links: [{ target: "Trash Over rm", path: "memories/trash-over-rm-2.md" }],
  backlinks: ["references/schedule.md"],
};

describe("rewriteWikilinks", () => {
  it("turns resolved wikilinks into /vault links, preserving aliases", () => {
    const out = rewriteWikilinks("See [[Anna|the teacher]] and [[Anna#Schedule]].", [
      { target: "Anna", path: "memories/anna-1.md" },
    ]);
    expect(out).toContain("[the teacher](/vault?path=memories%2Fanna-1.md)");
    expect(out).toContain("[Anna#Schedule](/vault?path=memories%2Fanna-1.md)");
  });

  it("leaves dangling wikilinks as literal text", () => {
    const out = rewriteWikilinks("See [[Ghost Doc]].", [{ target: "Ghost Doc", path: null }]);
    expect(out).toContain("[[Ghost Doc]]");
  });
});

describe("MarkdownContent", () => {
  it("renders a resolved wikilink as an in-vault anchor", () => {
    render(<MarkdownContent body={memoryFile.body} links={memoryFile.links} />);
    const anchor = screen.getByRole("link", { name: "Trash Over rm" });
    expect(anchor).toHaveAttribute("href", "/vault?path=memories%2Ftrash-over-rm-2.md");
  });
});

describe("FileView", () => {
  it("shows the frontmatter property table and the backlinks pane", () => {
    render(<FileView file={memoryFile} />);
    const properties = screen.getByRole("region", { name: "Frontmatter" });
    expect(properties).toHaveTextContent("mem_1");
    expect(properties).toHaveTextContent("people, music");
    const backlinks = screen.getByRole("region", { name: "Backlinks" });
    const backlink = screen.getByRole("link", { name: "references/schedule.md" });
    expect(backlinks).toContainElement(backlink);
    expect(backlink).toHaveAttribute("href", "/vault?path=references%2Fschedule.md");
  });
});
