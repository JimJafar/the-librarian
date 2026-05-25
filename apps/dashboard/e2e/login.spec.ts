import { expect, test } from "@playwright/test";

// A2/D3.3: the login surface. global-setup configures the store's auth methods
// (password + both OAuth providers) but leaves enforcement OFF, so this stays a
// render smoke (no redirect of other specs). The OAuth buttons render from the
// configured store providers. The unauth-redirect / fail-closed flows are
// unit-tested (tests/auth-gate, tests/trpc-proxy-gate); password sign-in + lockout
// are exercised in auth-password.spec.ts.
test.describe("login page", () => {
  test("renders the provider sign-in controls chrome-free", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: /Continue with GitHub/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Continue with Google/ })).toBeVisible();
    // Chrome-free: the persistent site nav is not rendered on /login.
    await expect(page.getByRole("navigation")).toHaveCount(0);
  });
});
