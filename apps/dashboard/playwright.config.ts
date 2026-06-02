import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Playwright loads this file in CommonJS mode (the dashboard package isn't
// `"type": "module"` so Next.js can keep its own runtime semantics), so
// `import.meta.url` is unavailable. `process.cwd()` is the dashboard's
// own directory when invoked via `pnpm --filter @librarian/dashboard`.
const dashboardDir = process.cwd();
const workspaceRoot = path.resolve(dashboardDir, "../..");

const E2E_ADMIN_TOKEN = process.env.LIBRARIAN_E2E_ADMIN_TOKEN ?? "e2e-admin-token";
// Resolve a fresh data dir per run at config-load time. The webServer
// launches the mcp-server BEFORE any test code (or globalSetup) executes,
// so the dir must already point somewhere unused — wiping it later would
// pull SQLite out from under the live server. CI passes its own dir via
// LIBRARIAN_E2E_DATA_DIR (runner.temp); local runs get a tmp-suffixed dir.
const E2E_DATA_DIR =
  process.env.LIBRARIAN_E2E_DATA_DIR ??
  path.join(os.tmpdir(), `librarian-e2e-${process.pid}-${Date.now()}`);
const E2E_SERVER_URL = process.env.LIBRARIAN_E2E_SERVER_URL ?? "http://127.0.0.1:3838";
const E2E_DASHBOARD_URL = process.env.LIBRARIAN_E2E_DASHBOARD_URL ?? "http://127.0.0.1:3000";

// Expose the resolved values back to tests + globalSetup.
process.env.LIBRARIAN_E2E_DATA_DIR = E2E_DATA_DIR;
process.env.LIBRARIAN_E2E_ADMIN_TOKEN = E2E_ADMIN_TOKEN;
process.env.LIBRARIAN_E2E_SERVER_URL = E2E_SERVER_URL;
process.env.LIBRARIAN_E2E_DASHBOARD_URL = E2E_DASHBOARD_URL;

export default defineConfig({
  testDir: "./e2e",
  // Configure the store's auth methods once before any spec (D3.4) — see
  // e2e/global-setup.ts. Enforcement stays off so other specs are unaffected.
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: E2E_DASHBOARD_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm --filter @librarian/mcp-server serve",
      cwd: workspaceRoot,
      url: `${E2E_SERVER_URL}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        ...(process.env as Record<string, string>),
        LIBRARIAN_ADMIN_TOKEN: E2E_ADMIN_TOKEN,
        LIBRARIAN_DATA_DIR: E2E_DATA_DIR,
        LIBRARIAN_PORT: new URL(E2E_SERVER_URL).port || "3838",
        // The dashboard is still SQLite-era (its logs view reads the event
        // ledger, retired on markdown — the git-history rework is F10). The
        // shipped server now defaults to markdown, so pin the e2e server to
        // sqlite until the dashboard is markdown-ready.
        LIBRARIAN_BACKEND: process.env.LIBRARIAN_BACKEND || "sqlite",
      },
    },
    {
      // `next start` emits a "use the standalone server" warning under
      // `output: "standalone"` — the standalone artefact is missing the
      // workspace-cwd static assets, so we stick with `next start` for
      // e2e parity with the dev server. The warning is benign.
      command: "pnpm --filter @librarian/dashboard start",
      cwd: workspaceRoot,
      url: E2E_DASHBOARD_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
      env: {
        ...(process.env as Record<string, string>),
        LIBRARIAN_ADMIN_TOKEN: E2E_ADMIN_TOKEN,
        LIBRARIAN_SERVER_URL: E2E_SERVER_URL,
        // Short auth-config cache so globalSetup's config propagates within a test.
        LIBRARIAN_AUTH_CONFIG_TTL_MS: "1000",
        // Raise the credentials rate limit so the store-side LOCKOUT is what the
        // password spec exercises, not the dashboard throttle.
        LIBRARIAN_CREDENTIALS_RATE_LIMIT: "100",
      },
    },
  ],
});
