import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoryTags } from "@/components/memories/memory-tags";

describe("MemoryTags", () => {
  it("renders no chrome when there are no stored tags", () => {
    const { container } = render(<MemoryTags tags={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("shows up to three tags in stored order and names the hidden remainder", () => {
    render(<MemoryTags tags={["first", "second", "third", "fourth", "fifth"]} />);

    expect(screen.getAllByTestId("memory-tag").map((tag) => tag.textContent)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(screen.queryByText("fourth")).not.toBeInTheDocument();
    expect(screen.getByText("+2 more")).toHaveAccessibleName("2 more tags");
  });

  it("renders long markup-shaped values as bounded text with the full value available", () => {
    const hostile = '<img src=x onerror="alert(1)">-a-very-long-tag-value';
    const { container } = render(<MemoryTags tags={[hostile]} />);

    const tag = screen.getByText(hostile);
    expect(tag).toHaveAttribute("title", hostile);
    expect(tag).toHaveClass("truncate");
    expect(container.querySelector("img")).toBeNull();
  });

  it("uses informational spans unless selection is explicitly enabled", () => {
    render(<MemoryTags tags={["decision"]} />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("decision").tagName).toBe("SPAN");
  });

  it("exposes selectable tags as named keyboard buttons", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<MemoryTags tags={["decision"]} onSelect={onSelect} />);

    const tag = screen.getByRole("button", { name: "Filter by tag decision" });
    await user.tab();
    expect(tag).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("decision");
  });
});
