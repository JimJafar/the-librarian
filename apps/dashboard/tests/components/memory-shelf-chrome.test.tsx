import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MemoryRow } from "@/components/memories/types";

vi.mock("@/components/memories/memory-detail-content", () => ({
  MemoryDetailContent: () => <div>detail body</div>,
}));

const { MemoryInspector } = await import("@/components/memories/memory-inspector");
const { MemoryBottomSheet } = await import("@/components/memories/memory-bottom-sheet");

function memory(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: "mem_1",
    title: "A memory",
    body: "body",
    tags: [],
    is_global: false,
    requires_approval: false,
    ...overrides,
  } as MemoryRow;
}

describe("memory detail shelf chrome", () => {
  it("renders the shelf pill in the desktop inspector header", () => {
    render(
      <MemoryInspector
        memory={memory({ shelfId: "team", shelfLabel: "Team shelf" })}
        onClose={() => {}}
        onMutated={() => {}}
      />,
    );

    expect(screen.getByText("Team shelf")).toHaveAttribute("title", "team");
  });

  it("renders the shelf pill in the mobile bottom-sheet header", () => {
    render(
      <MemoryBottomSheet
        memory={memory({ shelfId: "team", shelfLabel: "Team shelf" })}
        open
        onOpenChange={() => {}}
        onMutated={() => {}}
      />,
    );

    expect(screen.getByText("Team shelf")).toHaveAttribute("title", "team");
  });

  it("keeps both detail headers free of shelf chrome without attribution", () => {
    const { rerender } = render(
      <MemoryInspector memory={memory()} onClose={() => {}} onMutated={() => {}} />,
    );
    expect(screen.queryByText(/shelf/i)).not.toBeInTheDocument();

    rerender(
      <MemoryBottomSheet memory={memory()} open onOpenChange={() => {}} onMutated={() => {}} />,
    );
    expect(screen.queryByText(/shelf/i)).not.toBeInTheDocument();
  });
});
