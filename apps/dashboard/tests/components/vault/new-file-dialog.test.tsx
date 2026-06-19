// New-file dialog (spec 2026-06-19, Task 2): the path is now chosen with the
// VaultPathPicker folder combobox + a filename field, instead of typing the
// whole vault-relative path by hand.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

const { NewFileDialog } = await import("@/components/vault/new-file-dialog");

const DIRS = ["", "memories", "references", "references/AI", "handoffs"];

afterEach(() => vi.clearAllMocks());

describe("NewFileDialog", () => {
  it("composes the chosen folder + filename into the created path", async () => {
    const onCreate = vi.fn().mockResolvedValue({ ok: true });
    render(<NewFileDialog onCreate={onCreate} directories={DIRS} />);

    await userEvent.click(screen.getByRole("button", { name: /New file/ }));
    await userEvent.type(await screen.findByRole("combobox", { name: "Folder" }), "references/AI");
    await userEvent.type(screen.getByRole("textbox", { name: "File name" }), "style.md");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    await vi.waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({ path: "references/AI/style.md", raw: "" }),
    );
  });

  it("creates at the vault root when no folder is chosen", async () => {
    const onCreate = vi.fn().mockResolvedValue({ ok: true });
    render(<NewFileDialog onCreate={onCreate} directories={DIRS} />);

    await userEvent.click(screen.getByRole("button", { name: /New file/ }));
    await userEvent.type(await screen.findByRole("textbox", { name: "File name" }), "root-note.md");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    await vi.waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({ path: "root-note.md", raw: "" }),
    );
  });
});
