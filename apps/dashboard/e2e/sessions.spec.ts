import { expect, test } from "@playwright/test";
import { createTestSession } from "./fixtures";

test.describe("sessions list + archive/restore", () => {
  let sessionId: string;
  let sessionTitle: string;

  test.beforeAll(async () => {
    sessionTitle = `e2e-session-${Date.now()}`;
    const session = await createTestSession(sessionTitle);
    sessionId = session.id;
  });

  test("archives and restores a session", async ({ page }) => {
    page.on("dialog", (dialog) => dialog.accept(""));

    await page.goto("/sessions");
    await expect(page.getByRole("heading", { name: "Sessions", level: 1 })).toBeVisible();
    await expect(page.getByText(sessionTitle)).toBeVisible();

    await page.goto(`/sessions/${sessionId}`);
    await expect(page.getByRole("heading", { name: sessionTitle, level: 1 })).toBeVisible();
    await expect(page.getByText("active", { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByText("archived", { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByText("active", { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("search box drives the sessions.search browser tRPC path", async ({ page }) => {
    // Exercises the second sessions browser-tRPC path that the T6.3 proxy
    // bug had silently broken. Empty query uses `.list`, populating the
    // search input flips to `.search` — we verify the row still resolves.
    await page.goto("/sessions");
    await page.getByPlaceholder("title, summary, decisions, notes").fill(sessionTitle);
    await expect(page.getByText(sessionTitle)).toBeVisible({ timeout: 15_000 });
  });
});
