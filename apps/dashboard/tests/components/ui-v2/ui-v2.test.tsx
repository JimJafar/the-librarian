// D1.0 — smoke tests for the editorial design-system stubs.
//
// One test per stub. The goal is to pin existence + a minimal
// rendering contract (role, key text, key attribute) so that the
// later phases (D1.1+) can extend each component without losing
// the baseline shape that the rest of the dashboard imports.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui-v2/button";
import { CommandPalette } from "@/components/ui-v2/command-palette";
import { FilterChip } from "@/components/ui-v2/filter-chip";
import { Hairline } from "@/components/ui-v2/hairline";
import { Inspector } from "@/components/ui-v2/inspector";
import { KeyHint } from "@/components/ui-v2/key-hint";
import { Pill } from "@/components/ui-v2/pill";

describe("ui-v2 primitives", () => {
  it("Button renders a button with its label", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("Button applies the primary variant when requested", () => {
    render(<Button variant="primary">Apply</Button>);
    const btn = screen.getByRole("button", { name: "Apply" });
    expect(btn.className).toMatch(/ink-accent/);
  });

  it("Button applies the ghost variant when requested", () => {
    render(<Button variant="ghost">Cancel</Button>);
    const btn = screen.getByRole("button", { name: "Cancel" });
    expect(btn.className).toMatch(/border-transparent/);
  });

  it("Pill renders mono-styled content", () => {
    render(<Pill>mem_abc</Pill>);
    const pill = screen.getByText("mem_abc");
    expect(pill).toBeInTheDocument();
    expect(pill.className).toMatch(/font-mono/);
  });

  it("Hairline renders a divider element", () => {
    const { container } = render(<Hairline />);
    expect(container.querySelector("hr")).not.toBeNull();
  });

  it("Inspector renders the supplied title and children in an aside", () => {
    render(
      <Inspector title="Detail">
        <p>body</p>
      </Inspector>,
    );
    expect(screen.getByRole("complementary")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Detail" })).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("CommandPalette renders a dialog when open, hidden when closed", () => {
    const { rerender } = render(<CommandPalette open={false} onOpenChange={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<CommandPalette open={true} onOpenChange={() => {}} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("FilterChip renders the label and value", () => {
    render(<FilterChip label="Agent" value="claude-code" />);
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("claude-code")).toBeInTheDocument();
  });

  it("KeyHint renders the key as a kbd element", () => {
    render(<KeyHint shortcut="a" />);
    const kbd = screen.getByText("a");
    expect(kbd.tagName.toLowerCase()).toBe("kbd");
  });
});
