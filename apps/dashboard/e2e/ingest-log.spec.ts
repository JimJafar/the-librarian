import { expect, test } from "@playwright/test";
import { seedIngestLog } from "./fixtures";

// Captures (ingest-log) panel end to end (reference-ingest spec criterion 15/22;
// D7). Seeds the ingest log via core helpers (the settings sidecar is read fresh
// per request, so the running server sees the seeded rows), then asserts the
// panel renders a failed row with its error + source for manual revisit, and a
// success row that links its filed reference into the vault explorer.
test.describe("captures (ingest-log) panel", () => {
  test("renders a failed row with error+source and a success row linking its path", async ({
    page,
  }) => {
    const stamp = Date.now();
    const savedPath = `references/e2e-saved-${stamp}.md`;
    const savedSource = `https://example.com/saved-${stamp}`;
    const failedSource = `https://example.com/broken-${stamp}`;
    const failedError = `fetch failed: 503 unavailable ${stamp}`;

    await seedIngestLog([
      { source: savedSource, via: "extension", outcome: "success", resultPath: savedPath },
      { source: failedSource, via: "ios", outcome: "failed", error: failedError },
    ]);

    await page.goto("/settings/ingest");
    await expect(page.getByRole("heading", { name: "Captures", level: 1 })).toBeVisible();

    // The failed row carries its (redacted) error and the source URL so the
    // operator can revisit and capture manually.
    const failedRow = page.locator("tr", { hasText: failedSource });
    await expect(failedRow).toBeVisible();
    await expect(failedRow).toContainText("Failed");
    await expect(failedRow).toContainText(failedError);

    // The success row links its filed reference into the vault explorer (?path=).
    const savedRow = page.locator("tr", { hasText: savedSource });
    await expect(savedRow).toBeVisible();
    await expect(savedRow).toContainText("Saved");
    const link = savedRow.getByRole("link", { name: savedPath });
    await expect(link).toHaveAttribute("href", `/?path=${encodeURIComponent(savedPath)}`);
  });
});
