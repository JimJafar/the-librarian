import { expect, test } from "@playwright/test";

// "Connect a device" end to end (reference-ingest spec criterion 14/21;
// D16/D17/D18). Exercises the capture-token mint + one-time reveal, the QR
// render, and the prominent http:// warning. The shared e2e dashboard is
// configured with an http server URL (LIBRARIAN_SERVER_URL=http://127.0.0.1…),
// so the insecure warning is expected on first load.
test.describe("connect a device page", () => {
  test("mints a capture token, renders the Shortcut QR, and warns on an http URL", async ({
    page,
  }) => {
    await page.goto("/settings/connect");
    await expect(page.getByRole("heading", { name: "Connect a device", level: 1 })).toBeVisible();

    // The iCloud Shortcut QR renders as an SVG (react-qr-code).
    const qr = page.getByLabel("Scan to add the Shortcut");
    await expect(qr).toBeVisible();
    expect(await qr.evaluate((el) => el.tagName.toLowerCase())).toBe("svg");

    // The server URL is http:// in the e2e env, so the plaintext warning shows.
    const insecure = page.locator("#server-url-insecure");
    await expect(insecure).toBeVisible();
    await expect(insecure).toContainText(/plaintext http/i);

    // Mint a capture token; the plaintext is revealed exactly once.
    const device = `e2e-device-${Date.now()}`;
    await page.getByPlaceholder("work laptop").fill(device);
    await page.getByRole("button", { name: "Mint capture token" }).click();

    const reveal = page.getByRole("status");
    await expect(reveal).toContainText(/won.t be shown again/);
    await expect(reveal.locator("code")).toContainText("lib.");
    await page.getByRole("button", { name: "Done" }).click();

    // It appears in the capture-token list, then revoking removes it.
    const row = page.locator("tr", { hasText: device });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Revoke" }).click();
    await expect(page.locator("tr", { hasText: device })).toHaveCount(0);
  });
});
