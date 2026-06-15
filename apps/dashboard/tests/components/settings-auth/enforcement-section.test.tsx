import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EnforcementSection } from "@/components/settings/auth/enforcement-section";

describe("EnforcementSection (D5 Phase 3 rebuild)", () => {
  it("enables auth with the admin token", async () => {
    const onEnable = vi.fn().mockResolvedValue({ ok: true });
    render(
      <EnforcementSection
        enabled={false}
        canEnable={true}
        onEnable={onEnable}
        onDisable={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^Admin token$/i), {
      target: { value: "libadmin_x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Enable enforcement/ }));
    await waitFor(() => expect(onEnable).toHaveBeenCalledWith("libadmin_x"));
    await waitFor(() => expect(screen.getByText(/Authentication enabled\./)).toBeInTheDocument());
  });

  it("clears the admin token on Enable failure", async () => {
    const onEnable = vi.fn().mockResolvedValue({ ok: false, error: "admin token does not match" });
    render(
      <EnforcementSection
        enabled={false}
        canEnable={true}
        onEnable={onEnable}
        onDisable={vi.fn()}
      />,
    );
    const tokenInput = screen.getByLabelText(/^Admin token$/i) as HTMLInputElement;
    fireEvent.change(tokenInput, { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: /Enable enforcement/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/does not match/));
    expect(tokenInput.value).toBe("");
  });

  it("disables the button until a method is configured", () => {
    render(
      <EnforcementSection
        enabled={false}
        canEnable={false}
        onEnable={vi.fn()}
        onDisable={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Enable enforcement/ })).toBeDisabled();
    expect(screen.getByText(/Configure at least one sign-in method/)).toBeInTheDocument();
  });

  it("shows the enforcement-on state with a Pause break-glass", () => {
    render(
      <EnforcementSection enabled={true} canEnable={true} onEnable={vi.fn()} onDisable={vi.fn()} />,
    );
    expect(screen.getByText(/Authentication is currently on/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Admin token$/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Pause authentication/ })).toBeInTheDocument();
  });

  it("requires confirmation before pausing, and surfaces failures inline", async () => {
    const onDisable = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "store unreachable" })
      .mockResolvedValueOnce({ ok: true });
    render(
      <EnforcementSection
        enabled={true}
        canEnable={true}
        onEnable={vi.fn()}
        onDisable={onDisable}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Pause authentication/ }));
    // Now in the inline confirm row — the action button reads "Pause authentication".
    const confirmBtn = await screen.findByRole("button", { name: "Pause authentication" });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/store unreachable/));
    // Still confirming — operator must know it didn't pause.
    expect(screen.getByRole("button", { name: "Pause authentication" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Pause authentication" }));
    await waitFor(() => expect(onDisable).toHaveBeenCalledTimes(2));
  });
});
