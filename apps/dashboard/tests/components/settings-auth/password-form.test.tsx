import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PasswordForm } from "@/components/settings/auth/password-form";

function fillByLabel(label: RegExp | string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("PasswordForm (D5.3)", () => {
  it("saves a valid username + password", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true });
    render(<PasswordForm username={null} onSave={onSave} />);
    fillByLabel(/^Username$/i, "owner");
    fillByLabel(/^New password$/i, "a-strong-passphrase");
    fillByLabel(/^Confirm password$/i, "a-strong-passphrase");
    fireEvent.click(screen.getByRole("button", { name: "Save password" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ username: "owner", password: "a-strong-passphrase" }),
    );
    await waitFor(() => expect(screen.getByText("Password saved.")).toBeInTheDocument());
  });

  it("rejects a too-short password without calling onSave", () => {
    const onSave = vi.fn();
    render(<PasswordForm username="owner" onSave={onSave} />);
    fillByLabel(/^New password$/i, "short");
    fillByLabel(/^Confirm password$/i, "short");
    fireEvent.click(screen.getByRole("button", { name: "Save password" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/at least 12 characters/);
  });

  it("rejects a mismatch without calling onSave", () => {
    const onSave = vi.fn();
    render(<PasswordForm username="owner" onSave={onSave} />);
    fillByLabel(/^New password$/i, "a-strong-passphrase");
    fillByLabel(/^Confirm password$/i, "different-passphrase");
    fireEvent.click(screen.getByRole("button", { name: "Save password" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/do not match/);
  });

  it("labels every input with a real <label htmlFor> (P0 a11y fix)", () => {
    render(<PasswordForm username={null} onSave={vi.fn()} />);
    expect(screen.getByLabelText(/^Username$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^New password$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Confirm password$/i)).toBeInTheDocument();
  });
});
