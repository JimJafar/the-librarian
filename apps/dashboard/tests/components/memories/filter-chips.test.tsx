// FilterChips: chip-row IA for filterable list surfaces. Replaces the
// previous MemoriesFilters sidebar tests. The grouping that used to
// live in MemoriesFilters now lives in the consumer's `buildFilterDefs`
// (see view.tsx); this test covers the *primitive* — chip rendering,
// add-trigger popovers, overflow collapse, clear-all.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const { FilterChips } = await import("@/components/memories/filter-chips");
type FilterDef = import("@/components/memories/filter-chips").FilterDef;

const AGENT_DEF: FilterDef = {
  key: "agent_id",
  label: "Agent",
  type: "select",
  groups: [
    { options: [{ value: "claude-code", label: "claude-code" }] },
    {
      label: "System actors",
      options: [
        { value: "system-memory-curator", label: "system-memory-curator" },
        { value: "cli", label: "cli" },
      ],
    },
  ],
};
// A second generic select dimension. FilterChips is a primitive over arbitrary
// filter defs (the memory project filter was removed when memories went
// project-less); this neutral def keeps the multi-dimension coverage.
const STATUS_DEF: FilterDef = {
  key: "status",
  label: "Status",
  type: "select",
  groups: [{ options: [{ value: "active", label: "active" }] }],
};
const FROM_DEF: FilterDef = { key: "from", label: "From", type: "date" };
const TO_DEF: FilterDef = { key: "to", label: "To", type: "date" };

const DEFS = [AGENT_DEF, STATUS_DEF, FROM_DEF, TO_DEF];

describe("FilterChips", () => {
  it("renders an add-chip trigger for every inactive filter dimension", () => {
    render(<FilterChips defs={DEFS} active={[]} onSet={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Agent/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Status/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();
  });

  it("renders an active chip showing the applied value + remove handle", () => {
    const onRemove = vi.fn();
    render(
      <FilterChips
        defs={DEFS}
        active={[{ key: "agent_id", value: "claude-code", display: "claude-code" }]}
        onSet={vi.fn()}
        onRemove={onRemove}
      />,
    );
    expect(screen.getByText("claude-code")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Agent filter" })).toBeInTheDocument();
  });

  it("opens the select popover with grouped options when the agent trigger is clicked", async () => {
    render(<FilterChips defs={DEFS} active={[]} onSet={vi.fn()} onRemove={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Agent/i }));
    const listbox = await screen.findByRole("listbox", { name: /Agent options/i });
    expect(within(listbox).getByText("System actors")).toBeInTheDocument();
    expect(within(listbox).getByRole("button", { name: "claude-code" })).toBeInTheDocument();
    expect(
      within(listbox).getByRole("button", { name: "system-memory-curator" }),
    ).toBeInTheDocument();
  });

  it("emits onSet with key + value + display when a select option is chosen", async () => {
    const onSet = vi.fn();
    render(<FilterChips defs={DEFS} active={[]} onSet={onSet} onRemove={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Agent/i }));
    await userEvent.click(await screen.findByRole("button", { name: "claude-code" }));
    expect(onSet).toHaveBeenCalledWith("agent_id", "claude-code", "claude-code");
  });

  it("collapses chips past maxVisible into an overflow +N more trigger", () => {
    // Force overflow: 4 inactive defs, maxVisible 2 → 2 visible + "+2 more"
    render(
      <FilterChips defs={DEFS} active={[]} onSet={vi.fn()} onRemove={vi.fn()} maxVisible={2} />,
    );
    expect(screen.getByRole("button", { name: /\+2 more/ })).toBeInTheDocument();
  });

  it("renders Clear all once at least one filter is active", async () => {
    const onSet = vi.fn();
    const onRemove = vi.fn();
    const onClearAll = vi.fn();
    render(
      <FilterChips
        defs={DEFS}
        active={[{ key: "agent_id", value: "claude-code", display: "claude-code" }]}
        onSet={onSet}
        onRemove={onRemove}
        onClearAll={onClearAll}
      />,
    );
    const clear = screen.getByRole("button", { name: "Clear all" });
    await userEvent.click(clear);
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });

  it("keeps an active filter rendered and clearable after its definition disappears", async () => {
    const onRemove = vi.fn();
    render(
      <FilterChips
        defs={DEFS}
        active={[{ key: "shelf", value: "team", display: "Team shelf" }]}
        onSet={vi.fn()}
        onRemove={onRemove}
      />,
    );

    expect(screen.getByText("Team shelf")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /remove shelf filter/i }));
    expect(onRemove).toHaveBeenCalledWith("shelf");
  });
});
