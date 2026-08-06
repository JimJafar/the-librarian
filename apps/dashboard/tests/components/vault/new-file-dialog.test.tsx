// New-file dialog (spec 2026-06-19, Task 2): the path is now chosen with the
// VaultPathPicker folder combobox + a filename field, instead of typing the
// whole vault-relative path by hand.

import { fireEvent, render, screen } from "@testing-library/react";
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
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue({ ok: true });
    render(<NewFileDialog onCreate={onCreate} directories={DIRS} />);

    await user.click(screen.getByRole("button", { name: /New file/ }));
    fireEvent.change(await screen.findByRole("combobox", { name: "Folder" }), {
      target: { value: "references/AI" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "File name" }), {
      target: { value: "style.md" },
    });
    await user.click(screen.getByRole("button", { name: "Create" }));

    await vi.waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({ path: "references/AI/style.md", raw: "" }),
    );
  });

  it("creates at the vault root when no folder is chosen", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue({ ok: true });
    render(<NewFileDialog onCreate={onCreate} directories={DIRS} />);

    await user.click(screen.getByRole("button", { name: /New file/ }));
    fireEvent.change(await screen.findByRole("textbox", { name: "File name" }), {
      target: { value: "root-note.md" },
    });
    await user.click(screen.getByRole("button", { name: "Create" }));

    await vi.waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({ path: "root-note.md", raw: "" }),
    );
  });
});
