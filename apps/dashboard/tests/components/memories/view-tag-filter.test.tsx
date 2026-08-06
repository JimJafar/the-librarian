import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  tagCounts: {
    data: [
      { tag: "Decision", count: 2 },
      { tag: "the-librarian", count: 1 },
    ] as Array<{ tag: string; count: number }> | undefined,
    isLoading: false,
    isError: false,
  },
  listInputs: [] as unknown[],
  selectedIds: [] as string[],
  tagRefetch: vi.fn(),
}));

const memory = {
  id: "mem_tagged",
  title: "Tagged memory",
  body: "body",
  status: "active",
  agent_id: "human",
  tags: ["Decision"],
  applies_to: [],
  supersedes: [],
  conflicts_with: [],
  flags: [],
  confidence: "high",
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
  is_global: false,
  requires_approval: false,
};

vi.mock("@/lib/trpc-client", () => ({
  trpc: {
    memories: {
      list: {
        useQuery: (input: unknown) => {
          state.listInputs.push(input);
          return {
            data: { memories: [memory], total: 30 },
            isLoading: false,
            isError: false,
            error: null,
            refetch: vi.fn(),
          };
        },
      },
      distinctValues: { useQuery: () => ({ data: ["human"] }) },
      tagCounts: { useQuery: () => ({ ...state.tagCounts, refetch: state.tagRefetch }) },
    },
    vault: {
      shelves: {
        useQuery: () => ({
          data: [{ id: "main", writable: true }],
          isLoading: false,
          isError: false,
        }),
      },
    },
  },
}));

vi.mock("@/app/(memories)/actions", () => ({
  recallAction: vi.fn(),
  searchReferencesAction: vi.fn(),
}));
vi.mock("@/hooks/use-media-query", () => ({ useMediaQuery: () => false }));
vi.mock("@/hooks/use-surface-shortcuts", () => ({ useSurfaceShortcuts: () => {} }));
vi.mock("@/components/memories/memory-inspector", () => ({
  MemoryInspector: ({
    memory,
    onMutated,
  }: {
    memory: { id: string } | null;
    onMutated: () => void;
  }) => {
    if (memory) state.selectedIds.push(memory.id);
    return memory ? <button onClick={onMutated}>Simulate memory mutation</button> : null;
  },
}));
vi.mock("@/components/memories/memory-bottom-sheet", () => ({ MemoryBottomSheet: () => null }));

const { MemoriesView } = await import("@/components/memories/view");

beforeEach(() => {
  state.tagCounts = {
    data: [
      { tag: "Decision", count: 2 },
      { tag: "the-librarian", count: 1 },
    ],
    isLoading: false,
    isError: false,
  };
  state.listInputs = [];
  state.selectedIds = [];
  state.tagRefetch.mockClear();
});

describe("MemoriesView tag filter", () => {
  it("searches counted options case-insensitively and keeps counts out of the active chip", async () => {
    render(<MemoriesView />);

    await userEvent.click(screen.getByRole("button", { name: /^tag$/i }));
    const picker = screen.getByRole("dialog", { name: "Tag options" });
    await userEvent.type(within(picker).getByPlaceholderText("Filter tag…"), "DECIS");
    expect(within(picker).getByRole("button", { name: "Decision · 2" })).toBeInTheDocument();
    expect(within(picker).queryByText("the-librarian · 1")).not.toBeInTheDocument();

    await userEvent.click(within(picker).getByRole("button", { name: "Decision · 2" }));

    const removeTag = screen.getByRole("button", { name: "Remove Tag filter" });
    expect(removeTag.parentElement).toHaveTextContent("Decision");
    expect(removeTag.parentElement).not.toHaveTextContent("Decision · 2");
    expect(state.listInputs.at(-1)).toEqual(expect.objectContaining({ tags: ["Decision"] }));
  });

  it("composes with an agent filter, resets pagination, and clears cleanly", async () => {
    render(<MemoriesView />);

    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(state.listInputs.at(-1)).toEqual(expect.objectContaining({ offset: 25 }));
    await userEvent.click(screen.getByRole("button", { name: /agent/i }));
    await userEvent.click(screen.getByRole("button", { name: "human" }));
    await userEvent.click(screen.getByRole("button", { name: /^tag$/i }));
    await userEvent.click(screen.getByRole("button", { name: "Decision · 2" }));

    expect(state.listInputs.at(-1)).toEqual(
      expect.objectContaining({ agent_id: "human", tags: ["Decision"], offset: 0 }),
    );

    await userEvent.click(screen.getByRole("button", { name: /remove tag filter/i }));
    expect(state.listInputs.at(-1)).toEqual(expect.objectContaining({ agent_id: "human" }));
    expect(state.listInputs.at(-1)).not.toHaveProperty("tags");
  });

  it("applies a card tag without opening the inspector", async () => {
    render(<MemoriesView />);

    await userEvent.click(screen.getByRole("button", { name: "Filter by tag Decision" }));

    expect(state.listInputs.at(-1)).toEqual(expect.objectContaining({ tags: ["Decision"] }));
    expect(state.selectedIds).toEqual([]);
  });

  it("fails soft when the catalogue query is unavailable and keeps an active tag clearable", async () => {
    const { rerender } = render(<MemoriesView />);
    await userEvent.click(screen.getByRole("button", { name: /^tag$/i }));
    await userEvent.click(screen.getByRole("button", { name: "Decision · 2" }));

    state.tagCounts = { data: undefined, isLoading: false, isError: true };
    rerender(<MemoriesView />);

    expect(screen.queryByRole("button", { name: /^tag$/i })).not.toBeInTheDocument();
    const removeTag = screen.getByRole("button", { name: /remove tags filter/i });
    expect(removeTag.parentElement).toHaveTextContent("Decision");
    expect(screen.getByText("Tagged memory")).toBeInTheDocument();
    await userEvent.click(removeTag);
    expect(state.listInputs.at(-1)).not.toHaveProperty("tags");
  });

  it("refreshes the tag catalogue after a memory mutation", async () => {
    render(<MemoriesView />);
    await userEvent.click(screen.getByRole("button", { name: /Tagged memory body/ }));
    await userEvent.click(screen.getByRole("button", { name: "Simulate memory mutation" }));

    expect(state.tagRefetch).toHaveBeenCalledTimes(1);
  });
});
