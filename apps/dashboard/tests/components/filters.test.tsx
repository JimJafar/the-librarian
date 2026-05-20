import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoriesFilters, type FilterState } from "@/components/memories/filters";

const BLANK: FilterState = {
  search: "",
  agent_id: "",
  project_key: "",
  category: "",
  visibility: "",
  from: "",
  to: "",
};

function renderFilters(overrides: Partial<FilterState> = {}, opts: { recalling?: boolean } = {}) {
  const onChange = vi.fn();
  const onRecall = vi.fn();
  render(
    <MemoriesFilters
      filters={{ ...BLANK, ...overrides }}
      onChange={onChange}
      onRecall={onRecall}
      recalling={opts.recalling ?? false}
    />,
  );
  return { onChange, onRecall };
}

describe("MemoriesFilters", () => {
  it("disables Recall when the search field is empty", () => {
    renderFilters({ search: "" });
    expect(screen.getByRole("button", { name: "Recall" })).toBeDisabled();
  });

  it("enables Recall once the search field has content", () => {
    renderFilters({ search: "hello" });
    expect(screen.getByRole("button", { name: "Recall" })).toBeEnabled();
  });

  it("shows a busy label while recalling and disables the button", () => {
    renderFilters({ search: "hello" }, { recalling: true });
    const button = screen.getByRole("button", { name: "Recalling…" });
    expect(button).toBeDisabled();
  });

  it("calls onRecall (not onChange) when Recall is clicked", async () => {
    const { onRecall, onChange } = renderFilters({ search: "hello" });
    await userEvent.click(screen.getByRole("button", { name: "Recall" }));
    expect(onRecall).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("emits onChange with the patched filter when the agent input changes", async () => {
    const { onChange } = renderFilters();
    await userEvent.type(screen.getByPlaceholderText("agent id"), "a");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ agent_id: "a" }));
  });
});
