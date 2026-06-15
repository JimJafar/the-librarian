// D1.4 — KeyboardHost integration test.
//
// Pins the two behaviours the spec calls out:
//   1. cmd/ctrl-k opens the command palette.
//   2. "?" opens the shortcut overlay (when no input is focused).
//
// The host depends on the trpc-client and next/navigation; both are
// mocked so the test stays a fast component-only check rather than
// a network round-trip.

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/",
}));

vi.mock("@/lib/trpc-client", () => ({
  trpc: {
    memories: { list: { useQuery: () => ({ data: { memories: [] } }) } },
    sessions: { list: { useQuery: () => ({ data: { sessions: [] } }) } },
  },
}));

const { KeyboardHost } = await import("@/components/keyboard-host");

describe("KeyboardHost", () => {
  it("opens the command palette on cmd-k", () => {
    render(<KeyboardHost />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Command palette search")).toBeInTheDocument();
  });

  it("opens the shortcuts overlay on ?", () => {
    render(<KeyboardHost />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("does not open the shortcuts overlay when typing ? into a text field", () => {
    render(
      <>
        <input data-testid="input" />
        <KeyboardHost />
      </>,
    );
    const input = screen.getByTestId("input");
    input.focus();
    fireEvent.keyDown(input, { key: "?" });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  });
});
