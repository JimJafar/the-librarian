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
        name: "anna-1.md",
        path: "memories/anna-1.md",
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
    expect(screen.getByRole("link", { name: "anna-1.md" })).toHaveAttribute(
      "href",
      "/vault?path=memories%2Fanna-1.md",
    );
    expect(screen.getByRole("link", { name: "primer.md" })).toHaveAttribute(
      "href",
      "/vault?path=primer.md",
    );
  });

  it("marks the selected file as the current page", () => {
    render(<FileTree nodes={tree} selectedPath="memories/anna-1.md" />);
    expect(screen.getByRole("link", { name: "anna-1.md" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "primer.md" })).not.toHaveAttribute("aria-current");
  });

  it("says so when the vault is empty", () => {
    render(<FileTree nodes={[]} selectedPath={null} />);
    expect(screen.getByText(/vault is empty/i)).toBeInTheDocument();
  });
});
