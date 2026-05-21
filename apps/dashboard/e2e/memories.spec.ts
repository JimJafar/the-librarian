import { expect, test } from "@playwright/test";
import { createTestMemory } from "./fixtures";

test.describe("memories list + detail", () => {
  let memoryTitle: string;

  test.beforeAll(async () => {
    memoryTitle = `e2e-memory-${Date.now()}`;
    await createTestMemory(
      memoryTitle,
      "Body for the e2e test memory. The list should render this and clicking should open the detail panel.",
    );
  });

  test("renders the memory and opens the detail panel on click", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Memories", level: 1 })).toBeVisible();
    const row = page.getByRole("button", { name: new RegExp(memoryTitle) });
    await expect(row).toBeVisible();

    await row.click();
    // The detail panel renders an aside with the memory title as an h2.
    await expect(page.getByRole("heading", { name: memoryTitle, level: 2 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Archive" })).toBeVisible();
  });
});
