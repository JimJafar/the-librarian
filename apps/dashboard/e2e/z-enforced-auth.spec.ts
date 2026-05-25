import { expect, test } from "@playwright/test";

// D2.4 regression: exercise the middleware with enforcement ACTUALLY ON. This is the
// path the other specs never hit (global-setup leaves enforcement off), and where a
// bug shipped — manually invoking the Auth.js v5 auth() wrapper threw at runtime
// ("js is not a function"), 500ing every gated page. Enabling auth on the shared
// webServer redirects every other spec, so this file is named to sort LAST (nothing
// runs after it) and it disables enforcement again in afterAll.

const SERVER_URL = process.env.LIBRARIAN_E2E_SERVER_URL ?? "http://127.0.0.1:3838";
const ADMIN_TOKEN = process.env.LIBRARIAN_E2E_ADMIN_TOKEN ?? "e2e-admin-token";
const CACHE_TTL_MS = 1500; // > the e2e LIBRARIAN_AUTH_CONFIG_TTL_MS so the dashboard refetches

async function setEnforcement(enabled: boolean): Promise<void> {
  const procedure = enabled ? "auth.enable" : "auth.disable";
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
    ...(enabled ? { body: JSON.stringify({ adminToken: ADMIN_TOKEN }) } : {}),
  };
  const res = await fetch(`${SERVER_URL}/trpc/${procedure}`, init);
  if (!res.ok) throw new Error(`${procedure} failed: ${res.status} ${await res.text()}`);
}

test.describe("enforced auth (middleware)", () => {
  test.beforeAll(async () => {
    await setEnforcement(true);
    await new Promise((r) => setTimeout(r, CACHE_TTL_MS)); // let the config cache expire
  });
  test.afterAll(async () => {
    await setEnforcement(false);
  });

  test("redirects an unauthenticated request to /login — not a 500", async ({ page }) => {
    const res = await page.goto("/");
    await expect(page).toHaveURL(/\/login/); // middleware redirected, didn't crash
    expect(res?.status()).toBeLessThan(400); // the /login page rendered (no 500)
  });

  test("still serves the excluded /login page under enforcement", async ({ page }) => {
    const res = await page.goto("/login");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });
});
