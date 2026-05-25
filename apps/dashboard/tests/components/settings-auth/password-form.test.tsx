import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PasswordForm } from "@/components/settings/auth/password-form";

function fill(label: string, value: string) {
  fireEvent.change(screen.getByPlaceholderText(label), { target: { value } });
}

describe("PasswordForm (D5.3)", () => {
  it("saves a valid username + password", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true });
    render(<PasswordForm username={null} onSave={onSave} />);
    fill("Username", "owner");
    fill("New password (at least 12 characters)", "a-strong-passphrase");
    fill("Confirm password", "a-strong-passphrase");
    fireEvent.click(screen.getByRole("button", { name: "Save password" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ username: "owner", password: "a-strong-passphrase" }),
    );
    await waitFor(() => expect(screen.getByText("Password saved.")).toBeInTheDocument());
  });

  it("rejects a too-short password without calling onSave", () => {
    const onSave = vi.fn();
    render(<PasswordForm username="owner" onSave={onSave} />);
    fill("New password (at least 12 characters)", "short");
    fill("Confirm password", "short");
    fireEvent.click(screen.getByRole("button", { name: "Save password" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/at least 12 characters/)).toBeInTheDocument();
  });

  it("rejects a mismatch without calling onSave", () => {
    const onSave = vi.fn();
    render(<PasswordForm username="owner" onSave={onSave} />);
    fill("New password (at least 12 characters)", "a-strong-passphrase");
    fill("Confirm password", "different-passphrase");
    fireEvent.click(screen.getByRole("button", { name: "Save password" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/do not match/)).toBeInTheDocument();
  });
});
