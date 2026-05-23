import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// MemoriesFilters reads memories.distinctValues to populate the agent
// and project dropdowns — stub the hook so the test runs without a
// tRPC provider. Values cover the existing assertions on the agent
// select option list.
vi.mock("@/lib/trpc-client", () => ({
  trpc: {
    memories: {
      distinctValues: {
        useQuery: () => ({
          data: ["claude-code", "codex", "cli", "system-memory-curator", "unknown-agent"],
        }),
      },
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

  it("groups system/reserved actors under a System actors optgroup (§7.5)", () => {
    renderFilters();
    // Scope to the Agent select — the mock feeds the same values to the
    // Project dropdown too, so global option queries would be ambiguous.
    const agent = screen.getByLabelText("Agent");
    const systemGroup = within(agent).getByRole("group", { name: "System actors" });
    expect(within(systemGroup).getByRole("option", { name: "system-memory-curator" })).toBeTruthy();
    expect(within(systemGroup).getByRole("option", { name: "cli" })).toBeTruthy();
    // A real agent must NOT be in the system group.
    expect(within(systemGroup).queryByRole("option", { name: "claude-code" })).toBeNull();
  });

  it("marks unknown-agent as legacy while keeping its filter value intact (§7.5)", () => {
    renderFilters();
    const agent = screen.getByLabelText("Agent");
    const legacy = within(agent).getByRole("option", { name: /unknown-agent.*legacy/i });
    expect(legacy).toHaveValue("unknown-agent");
  });

  it("keeps regular agents at the top level (outside any optgroup)", () => {
    renderFilters();
    const agent = screen.getByLabelText("Agent");
    const claudeOption = within(agent).getByRole("option", { name: "claude-code" });
    expect(claudeOption.closest("optgroup")).toBeNull();
  });
});
