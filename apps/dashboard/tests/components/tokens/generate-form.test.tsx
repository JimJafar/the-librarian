import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { GenerateTokenForm } = await import("@/components/tokens/generate-form");

function fillAndSubmit(agentId: string) {
  fireEvent.change(screen.getByPlaceholderText("claude"), { target: { value: agentId } });
  fireEvent.click(screen.getByRole("button", { name: "Generate" }));
}

describe("GenerateTokenForm", () => {
  it("reveals the new token once on success", async () => {
    const onCreate = vi.fn().mockResolvedValue({ ok: true, id: "abc", token: "lib.abc.secret" });
    render(<GenerateTokenForm onCreate={onCreate} />);
    fillAndSubmit("claude");
    await waitFor(() => expect(screen.getByText("lib.abc.secret")).toBeInTheDocument());
    expect(onCreate).toHaveBeenCalledWith({ agentId: "claude" });
    expect(screen.getByText(/won.t be shown again/)).toBeInTheDocument();
  });

  it("surfaces an error and reveals nothing", async () => {
    const onCreate = vi.fn().mockResolvedValue({ ok: false, error: "boom" });
    render(<GenerateTokenForm onCreate={onCreate} />);
    fillAndSubmit("claude");
    await waitFor(() => expect(screen.getByText(/Error: boom/)).toBeInTheDocument());
    expect(screen.queryByText(/won.t be shown again/)).toBeNull();
  });

  it("does not submit an empty agent id", () => {
    const onCreate = vi.fn();
    render(<GenerateTokenForm onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(onCreate).not.toHaveBeenCalled();
  });
});
