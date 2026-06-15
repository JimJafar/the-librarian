import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OAuthWizard } from "@/components/settings/auth/oauth-wizard";

const CALLBACK = "https://dash.example.com/api/auth/callback/github";

function fillByLabel(label: RegExp | string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

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
    fillByLabel(/^Client ID$/i, "gh-id");
    fillByLabel(/^Client secret$/i, "gh-sec");
    fillByLabel(/^Owner account id$/i, "octocat");
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
    fillByLabel(/^Client ID$/i, "x");
    fillByLabel(/^Client secret$/i, "y");
    fillByLabel(/^Owner subject/i, "z");
    fireEvent.click(screen.getByRole("button", { name: "Save Google" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/are required/));
  });

  it("labels every input with a real <label htmlFor> (P0 a11y fix)", () => {
    render(
      <OAuthWizard
        provider="github"
        callbackUrl={CALLBACK}
        ownerId={null}
        configured={false}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/^Client ID$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Client secret$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Owner account id$/i)).toBeInTheDocument();
  });
});
