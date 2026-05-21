// D1.0 — smoke tests for the editorial design-system stubs.
//
// One test per stub. The goal is to pin existence + a minimal
// rendering contract (role, key text, key attribute) so that the
// later phases (D1.1+) can extend each component without losing
// the baseline shape that the rest of the dashboard imports.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FilterChip } from "@/components/ui-v2/filter-chip";
import { Hairline } from "@/components/ui-v2/hairline";
import { Inspector } from "@/components/ui-v2/inspector";
import { KeyHint } from "@/components/ui-v2/key-hint";
import { Pill } from "@/components/ui-v2/pill";

// The CommandPalette uses useRouter, so the mock must be in place
// before its import resolves. Async-import them after vi.mock runs.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const { Button } = await import("@/components/ui-v2/button");
const { CommandPalette } = await import("@/components/ui-v2/command-palette");
const { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } =
  await import("@/components/ui-v2/dialog");
const { Input } = await import("@/components/ui-v2/input");
const { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } =
  await import("@/components/ui-v2/table");
const { Tabs, TabsList, TabsTrigger, TabsContent } = await import("@/components/ui-v2/tabs");

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
    const props = {
      items: [{ id: "nav-mem", label: "Go to Memories", href: "/" }],
      query: "",
      onQueryChange: () => {},
    };
    const { rerender } = render(<CommandPalette open={false} onOpenChange={() => {}} {...props} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<CommandPalette open={true} onOpenChange={() => {}} {...props} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("option")).toHaveTextContent("Go to Memories");
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

  it("Dialog renders title, description, header, and footer when open", () => {
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm</DialogTitle>
            <DialogDescription>Are you sure?</DialogDescription>
          </DialogHeader>
          <p>body</p>
          <DialogFooter>
            <button type="button">Yes</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Confirm" })).toBeInTheDocument();
    expect(screen.getByText("Are you sure?")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Yes" })).toBeInTheDocument();
  });

  it("Dialog hides content when closed", () => {
    render(
      <Dialog open={false} onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Hidden</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Input renders an input element forwarding placeholder", () => {
    render(<Input placeholder="search" />);
    expect(screen.getByPlaceholderText("search")).toBeInTheDocument();
  });

  it("Input applies the mono variant when requested", () => {
    render(<Input variant="mono" placeholder="ses_..." />);
    const input = screen.getByPlaceholderText("ses_...");
    expect(input.className).toMatch(/font-mono/);
  });

  it("Table renders header + body rows", () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Col</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>cell</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole("columnheader", { name: "Col" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "cell" })).toBeInTheDocument();
  });

  it("TableRow surfaces a data-selected attribute via the standard prop", () => {
    render(
      <Table>
        <TableBody>
          <TableRow data-state="selected" data-testid="row">
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const row = screen.getByTestId("row");
    expect(row.getAttribute("data-state")).toBe("selected");
  });

  it("Tabs renders the active tab's content", () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
        <TabsContent value="a">alpha</TabsContent>
        <TabsContent value="b">beta</TabsContent>
      </Tabs>,
    );
    expect(screen.getByRole("tab", { name: "A" })).toBeInTheDocument();
    expect(screen.getByText("alpha")).toBeInTheDocument();
  });
});
