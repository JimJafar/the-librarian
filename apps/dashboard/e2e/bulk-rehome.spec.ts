// D1.1 — golden-path e2e for the bulk re-home flow.
//
// Creates three test memories, selects them via the multi-select checkbox in the
// memories list, opens the re-home modal, picks a target agent from the
// data-driven dropdown, and confirms the toast. Memories are project-less now, so
// re-home is agent-only — the target-project path is gone.

import { expect, test } from "@playwright/test";
import { createTestMemory } from "./fixtures";

test.describe("memories bulk re-home", () => {
  let titles: string[];

  test.beforeAll(async () => {
    const now = Date.now();
    titles = [`e2e-rehome-${now}-a`, `e2e-rehome-${now}-b`, `e2e-rehome-${now}-c`];
    // Seed under one agent so the three rows share a source owner.
    for (const t of titles) {
      await createTestMemory(t, `Body for ${t}.`, { agent_id: "e2e-source-agent" });
    }
    // Seed a memory under a DIFFERENT agent so the distinctValues dropdown has a
    // distinct target option to pick.
    await createTestMemory(`e2e-rehome-${now}-target`, "target seed", {
      agent_id: "e2e-target-agent",
    });
  });

  test("selecting three memories and re-homing them to a new agent in one round-trip", async ({
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

    // The modal lands with the target-agent dropdown.
    const dialog = page.getByRole("dialog", { name: /Re-home memories/i });
    await expect(dialog).toBeVisible();
    const targetAgent = dialog.getByLabel("Target agent");
    await targetAgent.waitFor({ state: "visible" });
    // Wait for distinctValues to populate the dropdown — beforeAll seeded an
    // "e2e-target-agent" alongside the three under "e2e-source-agent".
    await expect(targetAgent.locator('option[value="e2e-target-agent"]')).toHaveCount(1, {
      timeout: 10_000,
    });
    await targetAgent.selectOption("e2e-target-agent");

    await dialog.getByRole("button", { name: /Re-home 3/i }).click();

    // The toast confirms the count.
    await expect(page.getByRole("status")).toContainText(/Re-homed 3 memories\./i, {
      timeout: 15_000,
    });
  });
});
