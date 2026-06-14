// Vault file view (rethink T18/T19): rendered markdown with clickable
// wikilinks, the frontmatter property table, the backlinks pane, the editor
// (byte budget on primer/.curator, inline save errors, compare-and-swap hash),
// and the rename/delete confirm dialogs.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VaultFile } from "@/components/vault/types";

const refreshMock = vi.fn();
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, push: pushMock }),
}));

const { FileView } = await import("@/components/vault/file-view");
const { MarkdownContent, rewriteWikilinks } = await import("@/components/vault/markdown-content");
const { VaultEditor } = await import("@/components/vault/editor");

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

const actions = () => ({
  save: vi.fn().mockResolvedValue({ ok: true, hash: "h2" }),
  create: vi.fn().mockResolvedValue({ ok: true }),
  rename: vi.fn().mockResolvedValue({ ok: true, path: "x", changedLinks: [] }),
  remove: vi.fn().mockResolvedValue({ ok: true }),
  history: vi.fn().mockResolvedValue({ ok: true, commits: [] }),
  diff: vi.fn().mockResolvedValue({ ok: true, diff: "" }),
  restoreVersion: vi.fn().mockResolvedValue({ ok: true }),
});

afterEach(() => vi.clearAllMocks());

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
    render(<FileView file={memoryFile} actions={actions()} />);
    const properties = screen.getByRole("region", { name: "Frontmatter" });
    expect(properties).toHaveTextContent("mem_1");
    expect(properties).toHaveTextContent("people, music");
    const backlinks = screen.getByRole("region", { name: "Backlinks" });
    const backlink = screen.getByRole("link", { name: "references/schedule.md" });
    expect(backlinks).toContainElement(backlink);
    expect(backlink).toHaveAttribute("href", "/vault?path=references%2Fschedule.md");
  });

  it("Edit toggles the raw editor pre-filled with the file text", async () => {
    render(<FileView file={memoryFile} actions={actions()} />);
    // Edit / Read / History are now tabs (D1.x polish) — Radix renders them
    // as role=tab; Rename + Delete stay role=button since they open dialogs.
    await userEvent.click(screen.getByRole("tab", { name: "Edit" }));
    expect(screen.getByLabelText("Raw markdown")).toHaveValue(memoryFile.raw);
  });

  it("delete asks for confirmation before calling the action", async () => {
    const acts = actions();
    render(<FileView file={memoryFile} actions={acts} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(acts.remove).not.toHaveBeenCalled(); // dialog first, never direct
    await userEvent.click(await screen.findByRole("button", { name: "Delete file" }));
    await vi.waitFor(() => expect(acts.remove).toHaveBeenCalledWith({ path: memoryFile.path }));
  });

  it("rename sends from + to through the dialog", async () => {
    const acts = actions();
    render(<FileView file={memoryFile} actions={acts} />);
    await userEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = await screen.findByLabelText("New file path");
    await userEvent.clear(input);
    await userEvent.type(input, "memories/anna-renamed-1.md");
    await userEvent.click(screen.getByRole("button", { name: "Rename file" }));
    await vi.waitFor(() =>
      expect(acts.rename).toHaveBeenCalledWith({
        from: "memories/anna-1.md",
        to: "memories/anna-renamed-1.md",
      }),
    );
  });
});

describe("VaultEditor", () => {
  it("saves with the load-time hash (compare-and-swap) and exits on success", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true, hash: "h2" });
    const onDone = vi.fn();
    render(<VaultEditor file={memoryFile} onSave={onSave} onDone={onDone} />);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        path: memoryFile.path,
        raw: memoryFile.raw,
        expectedHash: "hash-1",
      }),
    );
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("surfaces a failed save inline and stays in the editor", async () => {
    const onSave = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "Invalid memory document frontmatter: id missing" });
    const onDone = vi.fn();
    render(<VaultEditor file={memoryFile} onSave={onSave} onDone={onDone} />);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/frontmatter/i));
    expect(onDone).not.toHaveBeenCalled();
  });

  it("shows the live byte budget for primer/.curator files", async () => {
    const primer: VaultFile = {
      ...memoryFile,
      path: "primer.md",
      kind: "primer",
      raw: "x".repeat(10),
      body: "x".repeat(10),
      frontmatter: null,
      links: [],
      backlinks: [],
    };
    render(<VaultEditor file={primer} onSave={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByText("10 / 2048 bytes")).toBeInTheDocument();
  });

  it("shows no byte budget for ordinary files", () => {
    render(<VaultEditor file={memoryFile} onSave={vi.fn()} onDone={vi.fn()} />);
    expect(screen.queryByText(/2048 bytes/)).not.toBeInTheDocument();
  });
});
