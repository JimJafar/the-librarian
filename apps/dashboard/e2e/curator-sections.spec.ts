import { expect, test } from "@playwright/test";

// C5b: the unified curator dashboard — ONE page, TWO parallel sections (Intake +
// Grooming), each with enablement, model config, recent runs, and run-now. This
// exercises the UI + the round-trip through the same-origin tRPC proxy and the
// real mcp-server intake/curator routers (auth is off in the shared e2e server,
// so this covers the controls + wiring, not the login gate — see global-setup.ts).
//
// No LLM provider is configured in the e2e store, so an intake run-now returns a
// {ran:false, reason:"disabled"|"incomplete_config"|...} skip — the test asserts
// that skip is SURFACED to the admin (not swallowed), which is the load-bearing
// C5b behaviour.

test.describe("unified curator dashboard", () => {
  test("both Intake and Grooming sections are present with their controls", async ({ page }) => {
    await page.goto("/curator");
    await expect(page.getByRole("heading", { name: "Memory Curator", level: 1 })).toBeVisible();

    const intake = page.getByRole("region", { name: "Intake", exact: true });
    const grooming = page.getByRole("region", { name: "Grooming", exact: true });

    // Each section is a clearly-labelled area with its own heading + run-now +
    // model controls + recent-runs.
    await expect(intake.getByRole("heading", { name: "Intake", level: 2 })).toBeVisible();
    await expect(grooming.getByRole("heading", { name: "Grooming", level: 2 })).toBeVisible();

    await expect(intake.getByRole("button", { name: "Run intake now" })).toBeVisible();
    await expect(grooming.getByRole("button", { name: "Run grooming now" })).toBeVisible();

    await expect(intake.getByRole("region", { name: "Intake run history" })).toBeVisible();
    await expect(grooming.getByRole("region", { name: "Grooming run history" })).toBeVisible();

    // Shared provider management lives once, outside the per-job sections.
    await expect(page.getByRole("region", { name: "LLM providers" })).toBeVisible();
  });

  test("intake enablement toggles and persists", async ({ page }) => {
    await page.goto("/curator");
    const intake = page.getByRole("region", { name: "Intake", exact: true });
    const form = intake.getByRole("form", { name: "Intake configuration form" });
    const toggle = form.getByRole("checkbox");

    // Read the current state, flip it, save, and confirm it persisted on reload.
    const before = await toggle.isChecked();
    await toggle.setChecked(!before);
    await form.getByRole("button", { name: "Save" }).click();
    await expect(form.getByText("Saved.")).toBeVisible();

    await page.reload();
    const intakeAfter = page.getByRole("region", { name: "Intake", exact: true });
    const toggleAfter = intakeAfter
      .getByRole("form", { name: "Intake configuration form" })
      .getByRole("checkbox");
    await expect(toggleAfter).toBeChecked({ checked: !before });

    // Restore the original state so the shared e2e store isn't left mutated.
    await toggleAfter.setChecked(before);
    await intakeAfter
      .getByRole("form", { name: "Intake configuration form" })
      .getByRole("button", {
        name: "Save",
      })
      .click();
    await expect(
      intakeAfter.getByRole("form", { name: "Intake configuration form" }).getByText("Saved."),
    ).toBeVisible();
  });

  test("intake run-now surfaces a skip reason when intake can't run", async ({ page }) => {
    await page.goto("/curator");
    const intake = page.getByRole("region", { name: "Intake", exact: true });

    // Ensure intake is disabled so run-now deterministically reports a skip.
    const form = intake.getByRole("form", { name: "Intake configuration form" });
    const toggle = form.getByRole("checkbox");
    if (await toggle.isChecked()) {
      await toggle.setChecked(false);
      await form.getByRole("button", { name: "Save" }).click();
      await expect(form.getByText("Saved.")).toBeVisible();
    }

    await intake.getByRole("button", { name: "Run intake now" }).click();
    // The {ran:false,reason} state is shown, never swallowed.
    await expect(intake.getByText(/Skipped — /)).toBeVisible();
  });

  test("grooming run-now is operable and reports a result", async ({ page }) => {
    await page.goto("/curator");
    const grooming = page.getByRole("region", { name: "Grooming", exact: true });
    await grooming.getByRole("button", { name: "Run grooming now" }).click();
    // With no provider configured the tick skips; either way the result is shown.
    await expect(grooming.getByText(/Ran — |Skipped — |Error: /)).toBeVisible();
  });
});
