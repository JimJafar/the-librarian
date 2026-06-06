import { expect, test } from "@playwright/test";

// B4b: the LLM provider manager + per-consumer model picker, end to end through
// the same-origin tRPC proxy and the real mcp-server llm router (auth is off in
// the shared e2e server, so this exercises the UI + round-trip, not the login
// gate — see tokens.spec.ts / A2 notes). The endpoint is an unreachable local
// port so the listModels probe fails soft and the free-text model fallback is
// what's under test — no real provider is contacted.
const UNREACHABLE_ENDPOINT = "http://127.0.0.1:1/v1";

test.describe("curator LLM providers", () => {
  test("add → edit → delete a provider", async ({ page }) => {
    const name = `e2e-provider-${Date.now()}`;
    await page.goto("/curator");
    await expect(page.getByRole("heading", { name: "Memory Curator", level: 1 })).toBeVisible();

    const providers = page.getByRole("region", { name: "LLM providers" });
    await providers.getByRole("button", { name: "Add provider" }).click();

    const addForm = providers.getByRole("form", { name: "Add provider" });
    await addForm.getByLabel("Name").fill(name);
    await addForm.getByLabel("Endpoint").fill(UNREACHABLE_ENDPOINT);
    await addForm.getByLabel(/API token/).fill("dummy-e2e-provider-token");
    await addForm.getByRole("button", { name: "Add" }).click();

    // The provider appears in the list with a "token set" marker (the secret is
    // never echoed back — only its presence).
    const row = providers.locator("li", { hasText: name });
    await expect(row).toBeVisible();
    await expect(row).toContainText("token set");

    // Edit the name; the token field stays blank (keep current) so the secret is
    // never round-tripped.
    await row.getByRole("button", { name: "Edit" }).click();
    const editForm = providers.getByRole("form", { name: new RegExp(`Edit provider ${name}`) });
    const renamed = `${name}-edited`;
    await editForm.getByLabel("Name").fill(renamed);
    await editForm.getByRole("button", { name: "Save" }).click();
    await expect(providers.locator("li", { hasText: renamed })).toBeVisible();

    // Delete it.
    const editedRow = providers.locator("li", { hasText: renamed });
    await editedRow.getByRole("button", { name: "Delete" }).click();
    await expect(providers.locator("li", { hasText: renamed })).toHaveCount(0);
  });

  test("model picker accepts free-text when listModels yields nothing", async ({ page }) => {
    const name = `e2e-model-${Date.now()}`;
    const model = "my-custom-model";
    await page.goto("/curator");

    // Create a provider whose unreachable endpoint makes listModels fail soft → [].
    const providers = page.getByRole("region", { name: "LLM providers" });
    await providers.getByRole("button", { name: "Add provider" }).click();
    const addForm = providers.getByRole("form", { name: "Add provider" });
    await addForm.getByLabel("Name").fill(name);
    await addForm.getByLabel("Endpoint").fill(UNREACHABLE_ENDPOINT);
    await addForm.getByLabel(/API token/).fill("dummy-e2e-model-token");
    await addForm.getByRole("button", { name: "Add" }).click();
    await expect(providers.locator("li", { hasText: name })).toBeVisible();

    // Point intake at it and type a model name by hand — the datalist is empty
    // (probe failed soft) but the free-text input still accepts the value.
    const intake = page.getByRole("form", { name: /Intake.*model selection/ });
    await intake.getByLabel("intake provider").selectOption({ label: name });
    const modelInput = intake.getByLabel("intake model");
    await modelInput.fill(model);
    await intake.getByRole("button", { name: "Save" }).click();
    await expect(intake.getByText("Saved.")).toBeVisible();

    // Reload: the saved free-text model persisted (round-tripped through the store).
    await page.reload();
    const intakeAfter = page.getByRole("form", { name: /Intake.*model selection/ });
    await expect(intakeAfter.getByLabel("intake model")).toHaveValue(model);
  });
});
