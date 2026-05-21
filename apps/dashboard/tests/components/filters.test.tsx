import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// MemoriesFilters reads memories.distinctValues to populate the agent
// and project dropdowns — stub the hook so the test runs without a
// tRPC provider. Values cover the existing assertions on the agent
// select option list.
vi.mock("@/lib/trpc-client", () => ({
  trpc: {
    memories: {
      distinctValues: { useQuery: () => ({ data: ["a", "claude-code", "codex"] }) },
    },
  },
}));

const { MemoriesFilters } = await import("@/components/memories/filters");
type FilterState = import("@/components/memories/filters").FilterState;

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

  it("emits onChange with the patched filter when the agent dropdown changes", async () => {
    const { onChange } = renderFilters();
    // Agent is now a data-driven dropdown rather than a free-text input
    // — pick an option populated by the mocked distinctValues hook.
    await userEvent.selectOptions(screen.getByLabelText("Agent"), "claude-code");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ agent_id: "claude-code" }));
  });
});
