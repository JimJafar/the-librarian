import { expect, test } from "@playwright/test";

// A5: the token-management flow end to end through the same-origin tRPC proxy
// and the real mcp-server tokens router (auth is off in the shared e2e server,
// so this exercises the UI + round-trip, not the login gate — see A2 notes).
test.describe("tokens page", () => {
  test("generate → one-time reveal → revoke", async ({ page }) => {
    const agentId = `e2e-${Date.now()}`;
    await page.goto("/settings/tokens");
    await expect(page.getByRole("heading", { name: "Agent tokens", level: 1 })).toBeVisible();

    await page.getByPlaceholder("claude").fill(agentId);
    await page.getByRole("button", { name: "Generate" }).click();

    // The plaintext is revealed exactly once, in the status callout.
    const reveal = page.getByRole("status");
    await expect(reveal).toContainText(/won.t be shown again/);
    await expect(reveal.locator("code")).toContainText("lib.");
    await page.getByRole("button", { name: "Done" }).click();

    // It shows up in the active list, then revoking removes it.
    const row = page.locator("tr", { hasText: agentId });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Revoke" }).click();
    await expect(page.locator("tr", { hasText: agentId })).toHaveCount(0);
  });
});
