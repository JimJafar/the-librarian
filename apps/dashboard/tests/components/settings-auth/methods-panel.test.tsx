import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MethodsPanel } from "@/components/settings/auth/methods-panel";

const METHODS = {
  password: { username: "owner" },
  github: { ownerId: "octocat" },
  google: null,
};

describe("MethodsPanel (D5.5)", () => {
  it("lists configured methods + owners (no secrets)", () => {
    render(<MethodsPanel enabled={false} methods={METHODS} onDisable={vi.fn()} />);
    expect(screen.getByText(/Password — owner/)).toBeInTheDocument();
    expect(screen.getByText(/GitHub — octocat/)).toBeInTheDocument();
    expect(screen.queryByText(/Google/)).toBeNull();
  });

  it("requires confirmation before disabling", async () => {
    const onDisable = vi.fn().mockResolvedValue({ ok: true });
    render(<MethodsPanel enabled={true} methods={METHODS} onDisable={onDisable} />);

    fireEvent.click(screen.getByRole("button", { name: "Disable authentication" }));
    expect(onDisable).not.toHaveBeenCalled(); // not yet — needs confirm
    fireEvent.click(screen.getByRole("button", { name: "Confirm disable" }));
    await waitFor(() => expect(onDisable).toHaveBeenCalledTimes(1));
  });

  it("surfaces a disable failure and keeps enforcement visibly on", async () => {
    const onDisable = vi.fn().mockResolvedValue({ ok: false, error: "store unreachable" });
    render(<MethodsPanel enabled={true} methods={METHODS} onDisable={onDisable} />);
    fireEvent.click(screen.getByRole("button", { name: "Disable authentication" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm disable" }));
    await waitFor(() => expect(screen.getByText(/store unreachable/)).toBeInTheDocument());
    // Still confirming (not silently dismissed) so the owner knows it didn't disable.
    expect(screen.getByRole("button", { name: "Confirm disable" })).toBeInTheDocument();
  });

  it("hides the disable control when auth is not enabled", () => {
    render(<MethodsPanel enabled={false} methods={METHODS} onDisable={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Disable authentication" })).toBeNull();
  });
});
