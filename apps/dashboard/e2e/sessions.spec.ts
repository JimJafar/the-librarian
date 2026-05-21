import { expect, test } from "@playwright/test";
import { createTestSession } from "./fixtures";

test.describe("sessions list + end/resume", () => {
  let sessionId: string;
  let sessionTitle: string;
  let searchSessionTitle: string;

  test.beforeAll(async () => {
    sessionTitle = `e2e-session-${Date.now()}`;
    const session = await createTestSession(sessionTitle);
    sessionId = session.id;
    // Separate session for the search test so it isn't affected by the
    // end/resume churn in the lifecycle test above.
    searchSessionTitle = `e2e-search-session-${Date.now()}`;
    await createTestSession(searchSessionTitle);
  });

  test("ends and resumes a session", async ({ page }) => {
    page.on("dialog", (dialog) => dialog.accept(""));

    await page.goto("/sessions");
    await expect(page.getByRole("heading", { name: "Sessions", level: 1 })).toBeVisible();
    await expect(page.getByText(sessionTitle)).toBeVisible();

    await page.goto(`/sessions/${sessionId}`);
    await expect(page.getByRole("heading", { name: sessionTitle, level: 1 })).toBeVisible();
    await expect(page.getByText("active", { exact: true }).first()).toBeVisible();

    // S1.1 collapsed archive/restore/delete into end + resume. End opens a
    // form; submit it (summary optional under the three-state model). Then
    // resume should bring the session back as paused.
    await page.getByRole("button", { name: "End" }).click();
    await page.getByRole("button", { name: "Submit end" }).click();
    await expect(page.getByText("ended", { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole("button", { name: "Resume" }).click();
    await expect(page.getByText(/active|paused/).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("search box drives the sessions.search browser tRPC path", async ({ page }) => {
    // Exercises the second sessions browser-tRPC path that the T6.3 proxy
    // bug had silently broken. Empty query uses `.list`, populating the
    // search input flips to `.search` — we verify the row still resolves.
    await page.goto("/sessions");
    await page.getByPlaceholder("title, summary, decisions, notes").fill(searchSessionTitle);
    await expect(page.getByText(searchSessionTitle)).toBeVisible({ timeout: 15_000 });
  });
});
