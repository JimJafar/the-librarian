import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// VaultPathPicker is a folder combobox over the vault's existing directories:
// type to filter, pick a folder (or type a brand-new one). Shared by the
// New-file dialog and the Move dialog (spec 2026-06-19). Controlled +
// presentational — no server.
const { VaultPathPicker } = await import("@/components/vault/vault-path-picker");

const DIRS = ["memories", "references", "references/AI", "handoffs"];

describe("VaultPathPicker", () => {
  it("filters the directory list by the current value (substring)", () => {
    render(<VaultPathPicker label="Folder" directories={DIRS} value="ref" onChange={vi.fn()} />);
    fireEvent.focus(screen.getByRole("combobox", { name: "Folder" }));
    const list = within(screen.getByRole("listbox"));
    expect(list.getByRole("option", { name: "references" })).toBeInTheDocument();
    expect(list.getByRole("option", { name: "references/AI" })).toBeInTheDocument();
    expect(list.queryByRole("option", { name: "memories" })).not.toBeInTheDocument();
    expect(list.queryByRole("option", { name: "handoffs" })).not.toBeInTheDocument();
  });

  it("fires onChange with the chosen directory when an option is clicked", () => {
    const onChange = vi.fn();
    render(<VaultPathPicker label="Folder" directories={DIRS} value="ref" onChange={onChange} />);
    fireEvent.focus(screen.getByRole("combobox", { name: "Folder" }));
    // mouseDown (not click) so selection beats the input's blur.
    fireEvent.mouseDown(screen.getByRole("option", { name: "references/AI" }));
    expect(onChange).toHaveBeenCalledWith("references/AI");
  });

  it("selects the highlighted option with ArrowDown + Enter", () => {
    const onChange = vi.fn();
    render(<VaultPathPicker label="Folder" directories={DIRS} value="" onChange={onChange} />);
    const input = screen.getByRole("combobox", { name: "Folder" });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" }); // highlight index 1
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(DIRS[1]);
  });

  it("lets the operator type a brand-new folder not in the list", () => {
    const onChange = vi.fn();
    render(<VaultPathPicker label="Folder" directories={DIRS} value="" onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Folder" }), {
      target: { value: "research/new" },
    });
    expect(onChange).toHaveBeenCalledWith("research/new");
  });
});
