import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SortBar, type SortState } from "@/components/memories/sort-bar";

function renderSortBar(initial: Partial<SortState> = {}) {
  const onChange = vi.fn();
  const sort: SortState = { field: "updated_at", order: "desc", ...initial };
  render(<SortBar sort={sort} onChange={onChange} />);
  return { onChange, sort };
}

describe("SortBar", () => {
  it("renders the four documented sort fields", () => {
    renderSortBar();
    const fieldSelect = screen.getByLabelText("Sort field") as HTMLSelectElement;
    const labels = Array.from(fieldSelect.options).map((o) => o.value);
    expect(labels).toEqual(["updated_at", "created_at", "title", "priority"]);
  });

  it("emits onChange with the next field while keeping the order", async () => {
    const { onChange } = renderSortBar({ field: "updated_at", order: "desc" });
    await userEvent.selectOptions(screen.getByLabelText("Sort field"), "title");
    expect(onChange).toHaveBeenCalledWith({ field: "title", order: "desc" });
  });

  it("emits onChange with the next order while keeping the field", async () => {
    const { onChange } = renderSortBar({ field: "updated_at", order: "desc" });
    await userEvent.selectOptions(screen.getByLabelText("Sort order"), "asc");
    expect(onChange).toHaveBeenCalledWith({ field: "updated_at", order: "asc" });
  });
});
