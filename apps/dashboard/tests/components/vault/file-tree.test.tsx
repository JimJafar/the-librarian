// Vault tree sidebar (rethink T18): dirs render as open groups, files as
// `?path=` links, and the selected file is marked as the current page.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { VaultTreeNode } from "@/components/vault/types";

const { FileTree } = await import("@/components/vault/file-tree");

const tree: VaultTreeNode[] = [
  {
    name: "memories",
    path: "memories",
    type: "dir",
    children: [
      {
        name: "elaine-1.md",
        path: "memories/elaine-1.md",
        type: "file",
        mtime: "2026-06-12T00:00:00.000Z",
      },
    ],
  },
  { name: "primer.md", path: "primer.md", type: "file", mtime: "2026-06-12T00:00:00.000Z" },
];

describe("FileTree", () => {
  it("renders dirs as groups and files as ?path= links", () => {
    render(<FileTree nodes={tree} selectedPath={null} />);
    expect(screen.getByText("memories/")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "elaine-1.md" })).toHaveAttribute(
      "href",
      "/?path=memories%2Felaine-1.md",
    );
    expect(screen.getByRole("link", { name: "primer.md" })).toHaveAttribute(
      "href",
      "/?path=primer.md",
    );
  });

  it("marks the selected file as the current page", () => {
    render(<FileTree nodes={tree} selectedPath="memories/elaine-1.md" />);
    expect(screen.getByRole("link", { name: "elaine-1.md" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "primer.md" })).not.toHaveAttribute("aria-current");
  });

  it("says so when the vault is empty", () => {
    render(<FileTree nodes={[]} selectedPath={null} />);
    expect(screen.getByText(/vault is empty/i)).toBeInTheDocument();
  });

  it("renders directories collapsed by default", () => {
    render(<FileTree nodes={tree} selectedPath={null} />);
    expect(screen.getByText("memories/").closest("details")).not.toHaveAttribute("open");
  });

  it("opens directories when forceOpen is set (active filter)", () => {
    render(<FileTree nodes={tree} selectedPath={null} forceOpen />);
    expect(screen.getByText("memories/").closest("details")).toHaveAttribute("open");
  });
});
