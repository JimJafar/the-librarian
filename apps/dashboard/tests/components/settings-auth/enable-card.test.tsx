import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EnableCard } from "@/components/settings/auth/enable-card";

describe("EnableCard (D5.2)", () => {
  it("enables auth with the admin token", async () => {
    const onEnable = vi.fn().mockResolvedValue({ ok: true });
    render(<EnableCard enabled={false} canEnable={true} onEnable={onEnable} />);
    fireEvent.change(screen.getByPlaceholderText("Admin token"), {
      target: { value: "libadmin_x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Enable authentication/ }));
    await waitFor(() => expect(onEnable).toHaveBeenCalledWith("libadmin_x"));
  });

  it("surfaces a wrong-token error", async () => {
    const onEnable = vi.fn().mockResolvedValue({ ok: false, error: "admin token does not match" });
    render(<EnableCard enabled={false} canEnable={true} onEnable={onEnable} />);
    fireEvent.change(screen.getByPlaceholderText("Admin token"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: /Enable authentication/ }));
    await waitFor(() => expect(screen.getByText(/does not match/)).toBeInTheDocument());
  });

  it("disables the button until a method is configured", () => {
    const onEnable = vi.fn();
    render(<EnableCard enabled={false} canEnable={false} onEnable={onEnable} />);
    expect(screen.getByRole("button", { name: /Enable authentication/ })).toBeDisabled();
    expect(screen.getByText(/Configure at least one login method/)).toBeInTheDocument();
  });

  it("shows the enabled state without a form", () => {
    render(<EnableCard enabled={true} canEnable={true} onEnable={vi.fn()} />);
    expect(screen.getByText(/Authentication is enabled/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Admin token")).toBeNull();
  });
});
