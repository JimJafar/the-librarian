import { expect, test } from "@playwright/test";
import { E2E_OWNER } from "./global-setup";

// D5.6: the /settings/auth wizard. global-setup configured the store's methods
// (enforcement OFF), so the page is reachable without a session and the cards
// render the configured state. We exercise the wizard UI → server action →
// store path (the saved confirmations prove the wiring). The full enable →
// enforce → login → lockout → CLI-reset chain is covered piecewise by unit
// tests (enforcement section, decideEnforcement, proxy-gate) and the
// auth-password e2e (login + lockout); enabling enforcement here would
// redirect every other spec on the shared webServer.
//
// IA (rc.17 redesign): Status strip + Step One (Sign-in methods: Password
// side-by-side with tabbed OAuth providers) + Step Two (Enforcement gate).

const NEW_PASSWORD = "wizard-chosen-passphrase";

test.describe("auth setup wizard", () => {
  test("renders the two-step layout with the configured state in the status strip", async ({
    page,
  }) => {
    await page.goto("/settings/auth");
    await expect(page.getByRole("heading", { name: "Authentication", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign-in methods", level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Enforcement", level: 2 })).toBeVisible();

    // The status strip surfaces the configured methods as pills.
    const strip = page.getByLabel("Authentication status");
    await expect(strip.getByText("Password", { exact: true })).toBeVisible();
    await expect(strip.getByText("GitHub", { exact: true })).toBeVisible();

    // The owner username configured by global-setup is the value of the
    // Password form's Username input (real label now, not a placeholder).
    await expect(page.getByLabel("Username", { exact: true })).toHaveValue(E2E_OWNER);
  });

  test("shows the exact OAuth callback URL to register (default GitHub tab)", async ({ page }) => {
    await page.goto("/settings/auth");
    await expect(page.getByText(/\/api\/auth\/callback\/github$/)).toBeVisible();
  });

  test("saves a new password through the wizard", async ({ page }) => {
    await page.goto("/settings/auth");
    const passwordForm = page.getByRole("form", { name: "Password login" });
    await passwordForm.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await passwordForm.getByLabel("Confirm password", { exact: true }).fill(NEW_PASSWORD);
    await passwordForm.getByRole("button", { name: "Save password" }).click();
    await expect(passwordForm.getByText("Password saved.")).toBeVisible();
  });

  test("saves OAuth creds + owner through the wizard (GitHub tab)", async ({ page }) => {
    await page.goto("/settings/auth");
    // GitHub is the default tab when both providers are configured.
    const github = page.getByRole("form", { name: "GitHub OAuth" });
    await github.getByLabel("Client ID", { exact: true }).fill("e2e-github-id-2");
    await github.getByLabel("Client secret", { exact: true }).fill("e2e-github-secret-2");
    await github.getByLabel("Owner account id", { exact: true }).fill("e2e-github-owner-2");
    await github.getByRole("button", { name: "Save GitHub" }).click();
    await expect(github.getByText(/Verify by signing in/)).toBeVisible();
  });
});
