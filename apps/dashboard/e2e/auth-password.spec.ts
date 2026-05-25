import { expect, test } from "@playwright/test";
import { E2E_OWNER, E2E_PASSWORD } from "./global-setup";

// D3.4: password login + lockout, against the store auth configured in global-setup
// (password + OAuth methods; enforcement left OFF so other specs are unaffected).
// "Lock persists across a store restart" is covered by unit tests (D1.2 — the lock
// is a plain setting that survives a fresh store handle); a server restart isn't
// expressible in the shared e2e webServer.

const WRONG = "e2e-wrong-password";

async function submitLogin(
  page: import("@playwright/test").Page,
  username: string,
  password: string,
): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForLoadState("networkidle");
}

async function sessionUser(page: import("@playwright/test").Page): Promise<string | null> {
  const res = await page.request.get("/api/auth/session");
  const body = (await res.json().catch(() => null)) as { user?: { name?: string } } | null;
  return body?.user?.name ?? null;
}

test.describe("password login", () => {
  test("renders the username + password form when a password is configured", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator('input[name="username"]')).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("signs in with the correct password", async ({ page }) => {
    await submitLogin(page, E2E_OWNER, E2E_PASSWORD);
    expect(await sessionUser(page)).toBe(E2E_OWNER);
  });

  test("locks out after repeated wrong passwords — even the correct one is then refused", async ({
    page,
  }) => {
    // Each test gets a fresh browser context, but the lockout is server-side. The
    // preceding success test clears it; these 5 misses trip it again.
    for (let i = 0; i < 5; i++) {
      await submitLogin(page, E2E_OWNER, WRONG);
      expect(await sessionUser(page)).toBeNull();
    }
    // Locked: the correct password is now refused too.
    await submitLogin(page, E2E_OWNER, E2E_PASSWORD);
    expect(await sessionUser(page)).toBeNull();
  });
});
