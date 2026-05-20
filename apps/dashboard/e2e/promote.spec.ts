import { expect, test } from "@playwright/test";
import { createTestSession } from "./fixtures";

test.describe("promote-to-memory", () => {
  let sessionId: string;
  let promotedTitle: string;

  test.beforeAll(async () => {
    const session = await createTestSession(`e2e-promote-source-${Date.now()}`);
    sessionId = session.id;
    promotedTitle = `e2e-promoted-${Date.now()}`;
  });

  test("promote form submits and the memory appears on the Memories tab", async ({ page }) => {
    await page.goto(`/sessions/${sessionId}`);

    const promoteSection = page.getByRole("heading", { name: "Promote to memory" });
    await expect(promoteSection).toBeVisible();

    const form = promoteSection.locator("xpath=ancestor::section");
    await form.getByLabel("Title").fill(promotedTitle);
    await form
      .getByLabel("Body")
      .fill(
        "Promoted via the e2e suite — verifies the round-trip from session detail to the memories list.",
      );
    await form.getByRole("button", { name: "Promote" }).click();

    await expect(form.getByText("Memory promoted.")).toBeVisible({ timeout: 15_000 });

    await page.goto("/");
    await expect(page.getByText(promotedTitle)).toBeVisible();
  });
});
