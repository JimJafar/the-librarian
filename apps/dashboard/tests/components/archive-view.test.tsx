import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const archivedMemory = {
  id: "mem_archived",
  title: "Old deployment note",
  body: "Use the retired script.",
  status: "archived",
  agent_id: "bede",
  tags: ["deployment", "legacy"],
  applies_to: [],
  supersedes: [],
  conflicts_with: [],
  flags: [],
  confidence: "high",
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-02T00:00:00.000Z",
  is_global: false,
  requires_approval: false,
};

vi.mock("@/lib/trpc-client", () => ({
  trpc: {
    memories: {
      list: {
        useQuery: () => ({
          data: { memories: [archivedMemory], total: 1 },
          isLoading: false,
          isError: false,
          error: null,
          refetch: vi.fn(),
        }),
      },
    },
  },
}));

vi.mock("@/components/memories/archive-delete-modal", () => ({
  ArchiveDeleteModal: () => null,
}));

const { ArchiveView } = await import("@/components/memories/archive-view");

describe("ArchiveView", () => {
  it("shows archived tags as informational pills", () => {
    render(<ArchiveView />);

    expect(screen.getByText("deployment").tagName).toBe("SPAN");
    expect(screen.getByText("legacy")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Filter by tag deployment" })).toBeNull();
  });
});
