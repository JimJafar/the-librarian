import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OAuthWizard } from "@/components/settings/auth/oauth-wizard";

const CALLBACK = "https://dash.example.com/api/auth/callback/github";

describe("OAuthWizard (D5.4)", () => {
  it("shows the exact callback URL to register", () => {
    render(
      <OAuthWizard
        provider="github"
        callbackUrl={CALLBACK}
        ownerId={null}
        configured={false}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText(CALLBACK)).toBeInTheDocument();
  });

  it("saves creds + owner and offers verify-by-signing-in", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true });
    render(
      <OAuthWizard
        provider="github"
        callbackUrl={CALLBACK}
        ownerId={null}
        configured={false}
        onSave={onSave}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("Client ID"), { target: { value: "gh-id" } });
    fireEvent.change(screen.getByPlaceholderText("Client secret"), { target: { value: "gh-sec" } });
    fireEvent.change(screen.getByPlaceholderText(/Owner account id/), {
      target: { value: "octocat" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save GitHub" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        clientId: "gh-id",
        clientSecret: "gh-sec",
        ownerId: "octocat",
      }),
    );
    await waitFor(() => expect(screen.getByText(/Verify by signing in/)).toBeInTheDocument());
  });

  it("surfaces a save error", async () => {
    const onSave = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "clientId and clientSecret are required" });
    render(
      <OAuthWizard
        provider="google"
        callbackUrl="https://x/api/auth/callback/google"
        ownerId={null}
        configured={false}
        onSave={onSave}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("Client ID"), { target: { value: "x" } });
    fireEvent.change(screen.getByPlaceholderText("Client secret"), { target: { value: "y" } });
    fireEvent.change(screen.getByPlaceholderText(/Owner sub/), { target: { value: "z" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Google" }));
    await waitFor(() => expect(screen.getByText(/are required/)).toBeInTheDocument());
  });
});
