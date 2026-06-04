import { expect, test } from "@playwright/test";

test.describe("logs page (browser-side tRPC events query)", () => {
  test("renders the empty event feed on the markdown backend", async ({ page }) => {
    // The append-only event ledger is retired on markdown (git history is the
    // audit trail; the logs-view git-history rework is F10). The `events` tRPC
    // procedure degrades to an empty feed, so the page must still render its
    // heading + empty state rather than 500.
    await page.goto("/logs");
    await expect(page.getByRole("heading", { name: "Logs", level: 1 })).toBeVisible();
    await expect(page.getByText("No logs match these filters.")).toBeVisible({ timeout: 15_000 });
  });
});
