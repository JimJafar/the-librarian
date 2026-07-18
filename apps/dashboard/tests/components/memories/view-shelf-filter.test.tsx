import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  shelves: {
    data: undefined as Array<{ id: string; label?: string; writable: boolean }> | undefined,
    isLoading: false,
    isError: false,
  },
  listInputs: [] as unknown[],
}));

vi.mock("@/lib/trpc-client", () => ({
  trpc: {
    memories: {
      list: {
        useQuery: (input: unknown) => {
          state.listInputs.push(input);
          return {
            data: { memories: [], total: 0 },
            isLoading: false,
            isError: false,
            error: null,
            refetch: vi.fn(),
          };
        },
      },
      distinctValues: {
        useQuery: () => ({ data: [] }),
      },
    },
    vault: {
      shelves: {
        useQuery: () => state.shelves,
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
vi.mock("@/components/memories/memory-inspector", () => ({ MemoryInspector: () => null }));
vi.mock("@/components/memories/memory-bottom-sheet", () => ({ MemoryBottomSheet: () => null }));

const { MemoriesView } = await import("@/components/memories/view");

beforeEach(() => {
  state.shelves = { data: undefined, isLoading: false, isError: false };
  state.listInputs = [];
});

describe("MemoriesView shelf filter", () => {
  it("appears only for multiple shelves and threads the selected id into memories.list", async () => {
    state.shelves.data = [
      { id: "personal", label: "My shelf", writable: true },
      { id: "team", label: "Team shelf", writable: false },
    ];
    render(<MemoriesView />);

    await userEvent.click(screen.getByRole("button", { name: /shelf/i }));
    const team = screen.getByRole("button", { name: "Team shelf" });
    expect(team).toHaveAttribute("title", "team");
    await userEvent.click(team);

    expect(state.listInputs.at(-1)).toEqual(expect.objectContaining({ shelf: "team" }));
  });

  it("omits the definition while loading, on error, and for one shelf", () => {
    state.shelves = { data: undefined, isLoading: true, isError: false };
    const { rerender } = render(<MemoriesView />);
    expect(screen.queryByRole("button", { name: /shelf/i })).not.toBeInTheDocument();

    state.shelves = { data: undefined, isLoading: false, isError: true };
    rerender(<MemoriesView />);
    expect(screen.queryByRole("button", { name: /shelf/i })).not.toBeInTheDocument();

    state.shelves = {
      data: [{ id: "main", writable: true }],
      isLoading: false,
      isError: false,
    };
    rerender(<MemoriesView />);
    expect(screen.queryByRole("button", { name: /shelf/i })).not.toBeInTheDocument();
  });

  it("keeps a stale active shelf clearable and requests the no-oracle empty list", async () => {
    state.shelves.data = [
      { id: "personal", writable: true },
      { id: "team", label: "Team shelf", writable: false },
    ];
    const { rerender } = render(<MemoriesView />);
    await userEvent.click(screen.getByRole("button", { name: /shelf/i }));
    await userEvent.click(screen.getByRole("button", { name: "Team shelf" }));

    state.shelves.data = [{ id: "personal", writable: true }];
    rerender(<MemoriesView />);

    expect(screen.getByText("Team shelf")).toBeInTheDocument();
    expect(screen.getByText(/no memories match/i)).toBeInTheDocument();
    expect(state.listInputs.at(-1)).toEqual(expect.objectContaining({ shelf: "team" }));

    await userEvent.click(screen.getByRole("button", { name: /remove shelf filter/i }));
    expect(state.listInputs.at(-1)).not.toHaveProperty("shelf");
  });
});
