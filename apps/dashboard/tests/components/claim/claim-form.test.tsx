import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const actionMock = vi.fn();
vi.mock("@/app/claim/actions", () => ({ redeemClaimAction: actionMock }));

const { ClaimForm } = await import("@/components/claim/claim-form");

function fillPasswords(password = "correct-horse-battery") {
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Confirm new password"), {
    target: { value: password },
  });
}

describe("ClaimForm", () => {
  it("prefills the token email read-only and gives every field a real label", () => {
    render(<ClaimForm token="v1.claim.mac" email="owner@example.com" />);

    expect(screen.getByLabelText("Owner email")).toHaveValue("owner@example.com");
    expect(screen.getByLabelText("Owner email")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("New password")).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByLabelText("Confirm new password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claim this Librarian" })).toBeInTheDocument();
  });

  it("announces a rejected claim inline", async () => {
    actionMock.mockResolvedValueOnce({ status: "error", error: "claim expired" });
    render(<ClaimForm token="v1.claim.mac" email="owner@example.com" />);
    fillPasswords();

    fireEvent.click(screen.getByRole("button", { name: "Claim this Librarian" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("claim expired");
    expect(actionMock).toHaveBeenCalledOnce();
    const submitted = actionMock.mock.calls[0]?.[1] as FormData;
    expect(submitted.get("token")).toBe("v1.claim.mac");
    expect(submitted.get("password")).toBe("correct-horse-battery");
  });

  it("renders the committed-owner fallback with sign-in and console links", async () => {
    actionMock.mockResolvedValueOnce({
      status: "claimed",
      loginHref: "/login",
      continueUrl: "https://console.example.test/claimed?claim_receipt=receipt",
    });
    render(<ClaimForm token="v1.claim.mac" email="owner@example.com" />);
    fillPasswords();

    fireEvent.click(screen.getByRole("button", { name: "Claim this Librarian" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Owner account created");
    expect(screen.getByRole("link", { name: /sign in/i })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: /continue to provisioning/i })).toHaveAttribute(
      "href",
      "https://console.example.test/claimed?claim_receipt=receipt",
    );
  });

  it("disables the submit control while the server action is pending", async () => {
    let resolveAction: ((value: { status: "error"; error: string }) => void) | undefined;
    actionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAction = resolve;
        }),
    );
    render(<ClaimForm token="v1.claim.mac" email="owner@example.com" />);
    fillPasswords();

    fireEvent.click(screen.getByRole("button", { name: "Claim this Librarian" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Claiming…" })).toBeDisabled());
    resolveAction?.({ status: "error", error: "claim expired" });
    await screen.findByRole("alert");
  });
});
