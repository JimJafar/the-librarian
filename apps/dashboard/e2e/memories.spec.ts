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
    await page.goto("/memories");

    await expect(page.getByRole("heading", { name: "Memories", level: 1 })).toBeVisible();
    const row = page.getByRole("button", { name: new RegExp(memoryTitle) });
    await expect(row).toBeVisible();

    await row.click();
    // The detail panel renders an aside with the memory title as an h2.
    await expect(page.getByRole("heading", { name: memoryTitle, level: 2 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Archive" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Shelf/ })).toHaveCount(0);
    await expect(page.locator("[data-shelf-token]")).toHaveCount(0);
  });

  test("does not overflow horizontally with a long title in a sub-fullscreen window", async ({
    page,
  }) => {
    // A long, unbroken title makes the truncated title's min-content huge; without
    // min-w-0 on the memories grid tracks, `truncate` can't constrain it and the
    // 1fr column forces the page wider than the viewport (the reported bug).
    await createTestMemory(`e2e-wide-${"x".repeat(200)}`, "Body for the overflow regression test.");
    await page.setViewportSize({ width: 900, height: 720 });
    await page.goto("/memories");
    await expect(page.getByRole("heading", { name: "Memories", level: 1 })).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1); // no horizontal page overflow
  });
});
