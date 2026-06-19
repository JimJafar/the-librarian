import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoriesList } from "@/components/memories/list";
import type { MemoryRow } from "@/components/memories/types";

function row(id: string): MemoryRow {
  return {
    id,
    title: `Title ${id}`,
    body: "body",
    updated_at: "2026-06-01T00:00:00.000Z",
  } as MemoryRow;
}

function renderList(selectedIds: Set<string>) {
  const onToggleSelectAll = vi.fn();
  render(
    <MemoriesList
      memories={[row("a"), row("b")]}
      isLoading={false}
      isError={false}
      selectedId={null}
      onSelect={() => {}}
      offset={0}
      pageSize={25}
      hasMore={false}
      onOffsetChange={() => {}}
      selectionEnabled
      selectedIds={selectedIds}
      onToggleSelected={() => {}}
      onToggleSelectAll={onToggleSelectAll}
    />,
  );
  return { onToggleSelectAll };
}

describe("MemoriesList select-all", () => {
  it("offers 'Select all' and requests selecting the page when none are selected", async () => {
    const { onToggleSelectAll } = renderList(new Set());
    const selectAll = screen.getByLabelText("Select all on this page") as HTMLInputElement;
    expect(selectAll.checked).toBe(false);
    expect(screen.getByText("Select all")).toBeTruthy();
    await userEvent.click(selectAll);
    expect(onToggleSelectAll).toHaveBeenCalledWith(true);
  });

  it("offers 'Deselect all' and requests clearing when the whole page is selected", async () => {
    const { onToggleSelectAll } = renderList(new Set(["a", "b"]));
    const selectAll = screen.getByLabelText("Select all on this page") as HTMLInputElement;
    expect(selectAll.checked).toBe(true);
    expect(screen.getByText("Deselect all")).toBeTruthy();
    await userEvent.click(selectAll);
    expect(onToggleSelectAll).toHaveBeenCalledWith(false);
  });

  it("renders the select-all box indeterminate on a partial page selection", () => {
    renderList(new Set(["a"]));
    const selectAll = screen.getByLabelText("Select all on this page") as HTMLInputElement;
    expect(selectAll.checked).toBe(false);
    expect(selectAll.indeterminate).toBe(true);
  });
});
