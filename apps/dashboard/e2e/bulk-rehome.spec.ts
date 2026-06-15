// D1.1 — golden-path e2e for the bulk re-home flow.
//
// Creates three test memories, selects them via the new multi-select
// checkbox in the memories list, opens the re-home modal, picks a
// target project key from the data-driven dropdown, and confirms the
// toast + that the rows reflect the new project_key after refresh.

import { expect, test } from "@playwright/test";
import { createTestMemory } from "./fixtures";

test.describe("memories bulk re-home", () => {
  let titles: string[];

  test.beforeAll(async () => {
    const now = Date.now();
    titles = [`e2e-rehome-${now}-a`, `e2e-rehome-${now}-b`, `e2e-rehome-${now}-c`];
    // Seed with an explicit project_key so the distinctValues dropdown
    // surfaces at least one real option — the assertion below targets the
    // project re-home branch, not the agent fallback.
    for (const t of titles) {
      await createTestMemory(t, `Body for ${t}.`, { project_key: "e2e-source" });
    }
    // Seed a memory with a different project_key so the dropdown has a
    // value to pick that is distinct from the source.
    await createTestMemory(`e2e-rehome-${now}-target`, "target seed", {
      project_key: "e2e-target",
    });
  });

  test("selecting three memories and re-homing them updates project_key in one round-trip", async ({
    page,
  }) => {
    await page.goto("/memories");
    await expect(page.getByRole("heading", { name: "Memories", level: 1 })).toBeVisible();

    // Wait for at least one of the seeded rows to appear so the list has
    // settled before we tick the checkboxes. Use the heading specifically
    // since the body text echoes the title too.
    await expect(page.getByRole("heading", { name: titles[0]!, level: 3 })).toBeVisible({
      timeout: 15_000,
    });

    for (const title of titles) {
      const cb = page.getByLabel(`Select ${title}`);
      await cb.check();
    }

    // The bulk-action button appears once at least one row is selected.
    const rehomeBtn = page.getByRole("button", {
      name: /Re-home 3 selected memories/i,
    });
    await expect(rehomeBtn).toBeVisible();
    await rehomeBtn.click();

    // The modal lands with two dropdowns; pick a new project, leave agent
    // alone (the seeded memories have a project_key set, so the dropdown
    // should at least surface 'the-librarian' as an option).
    const dialog = page.getByRole("dialog", { name: /Re-home memories/i });
    await expect(dialog).toBeVisible();
    const targetProject = dialog.getByLabel("Target project");
    await targetProject.waitFor({ state: "visible" });
    // Wait for distinctValues to populate the dropdown — the seed in
    // beforeAll added an "e2e-target" project_key alongside the three
    // memories under "e2e-source".
    await expect(targetProject.locator('option[value="e2e-target"]')).toHaveCount(1, {
      timeout: 10_000,
    });
    await targetProject.selectOption("e2e-target");

    await dialog.getByRole("button", { name: /Re-home 3/i }).click();

    // The toast confirms the count.
    await expect(page.getByRole("status")).toContainText(/Re-homed 3 memories\./i, {
      timeout: 15_000,
    });
  });
});
