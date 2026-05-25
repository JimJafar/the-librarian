import { expect, test } from "@playwright/test";
import { E2E_OWNER } from "./global-setup";

// D5.6: the /settings/auth wizard. global-setup configured the store's methods
// (enforcement OFF), so the page is reachable without a session and the cards render
// the configured state. We exercise the wizard UI → server action → store path
// (the saved confirmations prove the wiring). The full enable → enforce → login →
// lockout → CLI-reset chain is covered piecewise by unit tests (enable card,
// decideEnforcement, proxy-gate) and the auth-password e2e (login + lockout);
// enabling enforcement here would redirect every other spec on the shared webServer.

const NEW_PASSWORD = "wizard-chosen-passphrase";

test.describe("auth setup wizard", () => {
  test("renders all configuration cards with the current state", async ({ page }) => {
    await page.goto("/settings/auth");
    await expect(page.getByRole("heading", { name: "Enable authentication" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Password login" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "GitHub OAuth" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Google OAuth" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Configured methods" })).toBeVisible();
    // The methods panel lists what global-setup configured (no secrets).
    await expect(page.getByText(`Password — ${E2E_OWNER}`)).toBeVisible();
    await expect(page.getByText(/GitHub —/)).toBeVisible();
  });

  test("shows the exact OAuth callback URL to register", async ({ page }) => {
    await page.goto("/settings/auth");
    await expect(page.getByText(/\/api\/auth\/callback\/github$/)).toBeVisible();
  });

  test("saves a new password through the wizard", async ({ page }) => {
    await page.goto("/settings/auth");
    await page.getByPlaceholder(/New password/).fill(NEW_PASSWORD);
    await page.getByPlaceholder("Confirm password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Save password" }).click();
    await expect(page.getByText("Password saved.")).toBeVisible();
  });

  test("saves OAuth creds + owner through the wizard", async ({ page }) => {
    await page.goto("/settings/auth");
    // Scope to the GitHub OAuth card.
    const github = page.locator("section", { hasText: "GitHub OAuth" });
    await github.getByPlaceholder("Client ID").fill("e2e-github-id-2");
    await github.getByPlaceholder("Client secret").fill("e2e-github-secret-2");
    await github.getByPlaceholder(/Owner account id/).fill("e2e-github-owner-2");
    await github.getByRole("button", { name: "Save GitHub" }).click();
    await expect(github.getByText(/Verify by signing in/)).toBeVisible();
  });
});
