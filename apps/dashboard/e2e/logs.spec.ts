import { expect, test } from "@playwright/test";
import { createTestMemory } from "./fixtures";

test.describe("logs page (browser-side tRPC events query)", () => {
  test("renders memory events created during the run", async ({ page }) => {
    // Creating a memory emits `memory.created` into the event ledger;
    // the /logs page consumes `trpc.memories.events.useQuery` via the
    // same-origin proxy and renders the event row.
    await createTestMemory(
      `e2e-logs-${Date.now()}`,
      "Body to verify the logs page renders an event row through the proxy.",
    );

    await page.goto("/logs");
    await expect(page.getByRole("heading", { name: "Logs", level: 1 })).toBeVisible();
    // The event row renders the payload as a `<pre>` block. Targeting the
    // pre avoids matching the same event-type string inside the filter
    // <option> elements that share the dropdown.
    await expect(page.locator("ul pre").first()).toBeVisible({ timeout: 15_000 });
  });
});
