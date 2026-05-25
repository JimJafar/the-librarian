import { expect, test } from "@playwright/test";

// A2: the login surface. The shared e2e webServer runs with auth OFF (enabling
// it would redirect every other spec to /login), so this is a render smoke that
// the new page works in a real browser. The unauth-redirect and authed-session
// flows are unit-tested (tests/auth-gate, tests/trpc-proxy-gate) and require a
// dedicated auth-enabled server — see AUTONOMOUS-BUILD-NOTES.
test.describe("login page", () => {
  test("renders the provider sign-in controls chrome-free", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: /Continue with GitHub/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Continue with Google/ })).toBeVisible();
    // Chrome-free: the persistent site nav is not rendered on /login.
    await expect(page.getByRole("navigation")).toHaveCount(0);
  });
});
