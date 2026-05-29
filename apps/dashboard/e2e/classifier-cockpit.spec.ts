// /classifier cockpit smoke — admin can open the page, see the
// configuration summary, restart the worker on a disabled config (gets
// the "stopped" outcome), and run a self-test (gets the not-operational
// error outcome). The happy path (configure remote provider with a stub
// LLM end to end) is left as a follow-up because mcp-server doesn't yet
// have an LLM stub on the http path.

import { expect, test } from "@playwright/test";

test.describe("classifier cockpit", () => {
  test("admin sees the page, can restart the disabled worker, and run self-test", async ({
    page,
  }) => {
    await page.goto("/classifier");

    // The page header is the disambiguating element — the site nav
    // includes "Classifier" too, so we match the h1 specifically.
    await expect(page.getByRole("heading", { name: "Classifier", level: 1 })).toBeVisible();

    // Configuration summary shows the disabled state.
    await expect(page.getByText("Disabled", { exact: false })).toBeVisible();

    // Restart on a disabled worker reports the "stopped" outcome.
    await page.getByRole("button", { name: /restart classifier worker/i }).click();
    await expect(page.getByText(/stopped|already in progress/i, { exact: false })).toBeVisible({
      timeout: 15_000,
    });

    // Self-test on a non-operational config reports the disabled error.
    await page.getByRole("button", { name: /test classifier/i }).click();
    await expect(page.getByText(/disabled|operational/i, { exact: false })).toBeVisible({
      timeout: 15_000,
    });
  });
});
