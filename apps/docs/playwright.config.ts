import { defineConfig, devices } from "@playwright/test";

// The accessibility gate runs axe-core against the *built* static site, served
// by `astro preview`. Build first (`pnpm --filter @librarian/docs build`); the
// webServer below then serves the existing `dist/`.
const PREVIEW_URL = "http://localhost:4321";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // The a11y gate is made deterministic in-test (wait for fonts + networkidle
  // before axe runs); this single retry is only a small cushion, not the fix.
  retries: 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: PREVIEW_URL,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm preview",
    url: PREVIEW_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
