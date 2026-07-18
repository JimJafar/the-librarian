import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { ClaimForm } = await import("@/components/claim/claim-form");

function fillPasswords(password = "correct-horse-battery") {
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Confirm new password"), {
    target: { value: password },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
});

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
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "error", error: "claim expired" }, 400));
    render(<ClaimForm token="v1.claim.mac" email="owner@example.com" />);
    fillPasswords();

    fireEvent.click(screen.getByRole("button", { name: "Claim this Librarian" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("claim expired");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/claim/redeem");
    const submitted = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(submitted.token).toBe("v1.claim.mac");
    expect(submitted.password).toBe("correct-horse-battery");
  });

  it("renders the committed-owner fallback with sign-in and console links", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: "claimed",
        loginHref: "/login",
        continueUrl: "https://console.example.test/claimed?claim_receipt=receipt",
      }),
    );
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

  it("disables the submit control while the claim request is pending", async () => {
    let resolveRequest: ((value: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    render(<ClaimForm token="v1.claim.mac" email="owner@example.com" />);
    fillPasswords();

    fireEvent.click(screen.getByRole("button", { name: "Claim this Librarian" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Claiming…" })).toBeDisabled());
    resolveRequest?.(jsonResponse({ status: "error", error: "claim expired" }, 400));
    await screen.findByRole("alert");
  });
});
