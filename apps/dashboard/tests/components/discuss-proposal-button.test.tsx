import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// "Discuss this proposal" (proposal-review rework F5/D9): the proposal-scoped
// chat entry point. The load-bearing behaviour is the confirm binding — a
// chat-proposed action confirmed from THIS dialog carries the proposal id, so
// the server can consume the proposal (resolution: "resolved_via_chat").

const chatAction = vi.fn();
const confirmActionAction = vi.fn().mockResolvedValue({ ok: true });
const setAddendumAction = vi.fn();

vi.mock("@/app/curator/actions", () => ({
  chatAction: (...args: unknown[]) => chatAction(...args),
  confirmActionAction: (...args: unknown[]) => confirmActionAction(...args),
  setAddendumAction: (...args: unknown[]) => setAddendumAction(...args),
}));

// Stub ChatPanel: capture the confirm hook and expose a button that fires it
// with a canned action, so the test proves the proposal-id binding without
// booting the real chat.
vi.mock("@/components/curator/chat-panel", () => ({
  ChatPanel: ({
    memoryId,
    onConfirmAction,
  }: {
    memoryId: string;
    onConfirmAction: (action: unknown) => Promise<unknown>;
  }) => (
    <div data-testid="chat-panel" data-memory-id={memoryId}>
      <button
        onClick={() =>
          onConfirmAction({ type: "update", id: "mem_target", patch: { title: "fixed" } })
        }
      >
        stub-confirm
      </button>
    </div>
  ),
}));

const { DiscussProposalButton } = await import("@/components/curator/discuss-proposal-button");

beforeEach(() => {
  confirmActionAction.mockClear();
});

describe("DiscussProposalButton", () => {
  it("opens the chat dialog grounded in the proposal's memory id", async () => {
    render(<DiscussProposalButton proposalId="mem_prop" proposalTitle="A proposal" />);
    fireEvent.click(screen.getByRole("button", { name: "Discuss this proposal" }));
    await waitFor(() => expect(screen.getByTestId("chat-panel")).toBeInTheDocument());
    expect(screen.getByTestId("chat-panel").dataset.memoryId).toBe("mem_prop");
  });

  it("binds the proposal id into the confirm hook (D9)", async () => {
    render(<DiscussProposalButton proposalId="mem_prop" />);
    fireEvent.click(screen.getByRole("button", { name: "Discuss this proposal" }));
    await waitFor(() => expect(screen.getByTestId("chat-panel")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "stub-confirm" }));
    await waitFor(() =>
      expect(confirmActionAction).toHaveBeenCalledWith(
        { type: "update", id: "mem_target", patch: { title: "fixed" } },
        "mem_prop",
      ),
    );
  });
});
