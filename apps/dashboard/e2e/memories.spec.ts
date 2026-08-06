import { expect, test } from "@playwright/test";
import { createTestMemory } from "./fixtures";

test.describe("memories list + detail", () => {
  let memoryTitle: string;
  let matchingTitle: string;
  let excludedTitle: string;
  let sharedTag: string;
  let longTag: string;

  test.beforeAll(async () => {
    const stamp = Date.now();
    memoryTitle = `e2e-memory-${stamp}`;
    matchingTitle = `e2e-matching-${stamp}`;
    excludedTitle = `e2e-excluded-${stamp}`;
    sharedTag = `e2e-tag-${stamp}`;
    longTag = `e2e-tag-${"long-unbroken-".repeat(20)}${stamp}`;
    await createTestMemory(
      memoryTitle,
      "Body for the e2e test memory. The list should render this and clicking should open the detail panel.",
      { tags: [sharedTag, longTag] },
    );
    await createTestMemory(matchingTitle, "Another memory with the shared tag.", {
      tags: [sharedTag],
    });
    await createTestMemory(excludedTitle, "A memory outside the shared tag filter.", {
      tags: [`e2e-other-${stamp}`],
    });
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
    await expect(page.getByRole("button", { name: /^(Move|Propose move)/ })).toHaveCount(0);
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

  test("filters by counted picker and card tags without opening the inspector", async ({
    page,
  }) => {
    await page.goto("/memories");

    await page.getByRole("button", { name: "Tag", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Tag options" });
    await expect(picker.getByRole("button", { name: `${sharedTag} · 2` })).toBeVisible();
    await picker.getByRole("button", { name: `${sharedTag} · 2` }).click();

    await expect(page.getByRole("button", { name: new RegExp(memoryTitle) })).toBeVisible();
    await expect(page.getByRole("button", { name: new RegExp(matchingTitle) })).toBeVisible();
    await expect(page.getByRole("button", { name: new RegExp(excludedTitle) })).toHaveCount(0);

    await page.getByRole("button", { name: "Clear all" }).click();
    await expect(page.getByRole("button", { name: new RegExp(excludedTitle) })).toBeVisible();

    const card = page.getByRole("button", { name: new RegExp(memoryTitle) }).locator("..");
    await card.getByRole("button", { name: `Filter by tag ${sharedTag}` }).click();
    await expect(page.getByRole("button", { name: new RegExp(excludedTitle) })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: memoryTitle, level: 2 })).toHaveCount(0);

    await page.setViewportSize({ width: 320, height: 720 });
    const longTagPill = card.getByRole("button", { name: `Filter by tag ${longTag}` });
    await expect(longTagPill).toBeVisible();
    expect(await longTagPill.getAttribute("title")).toBe(longTag);
    expect(
      await longTagPill.evaluate((element) => element.getBoundingClientRect().width),
    ).toBeLessThanOrEqual(192);
    const cardOverflow = await card.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    );
    expect(cardOverflow).toBeLessThanOrEqual(1);

    await longTagPill.click();
    const activeTag = page.getByRole("button", { name: "Remove Tag filter" }).locator("..");
    await expect(activeTag.getByTitle(longTag)).toBeVisible();
    expect(
      await activeTag.evaluate((element) => element.getBoundingClientRect().width),
    ).toBeLessThanOrEqual(272);
    expect(
      await activeTag.evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1);
  });
});
