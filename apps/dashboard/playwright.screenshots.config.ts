import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Screenshot pipeline for the docs site (docs-site spec, Phase 3 / K4). Drives
// the live dashboard exactly the way the e2e suite does — same two-webServer
// boot (mcp-server admin/tRPC + `next start`), same auth-config global-setup
// (enforcement left OFF, so every route renders without a login redirect), same
// out-of-process seeding fixtures — but its specs CAPTURE one deterministic PNG
// per documented route instead of asserting behaviour. Kept as a SEPARATE config
// (not a project in playwright.config.ts) so `pnpm test:e2e` never captures and
// `pnpm screenshots` never runs the behavioural specs.
//
// Determinism (criterion #7): fixed 1280×800 viewport, deviceScaleFactor 1,
// reduced motion, forced light scheme; the spec additionally waits for fonts +
// networkidle and disables animations before each capture.

const dashboardDir = process.cwd();
const workspaceRoot = path.resolve(dashboardDir, "../..");

const ADMIN_TOKEN = process.env.LIBRARIAN_E2E_ADMIN_TOKEN ?? "e2e-admin-token";
const DATA_DIR =
  process.env.LIBRARIAN_E2E_DATA_DIR ??
  path.join(os.tmpdir(), `librarian-shots-${process.pid}-${Date.now()}`);
const SERVER_URL = process.env.LIBRARIAN_E2E_SERVER_URL ?? "http://127.0.0.1:3838";
const TRPC_URL = process.env.LIBRARIAN_E2E_TRPC_URL ?? "http://127.0.0.1:3840";
const DASHBOARD_URL = process.env.LIBRARIAN_E2E_DASHBOARD_URL ?? "http://127.0.0.1:3000";

// Expose the resolved values back to global-setup + the seeding fixtures.
process.env.LIBRARIAN_E2E_DATA_DIR = DATA_DIR;
process.env.LIBRARIAN_E2E_ADMIN_TOKEN = ADMIN_TOKEN;
process.env.LIBRARIAN_E2E_SERVER_URL = SERVER_URL;
process.env.LIBRARIAN_E2E_TRPC_URL = TRPC_URL;
process.env.LIBRARIAN_E2E_DASHBOARD_URL = DASHBOARD_URL;

export default defineConfig({
  testDir: "./screenshots",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // A capture occasionally races the dev server's first paint; one retry in CI
  // (matching the e2e job) absorbs that without masking a real failure.
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  // Generous: a capture seeds, navigates, waits for fonts + networkidle.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: DASHBOARD_URL,
    trace: "off",
  },
  projects: [
    {
      name: "screenshots",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        // Forced light scheme + reduced motion are applied per-page via
        // page.emulateMedia() in the capture spec (typed runtime API).
      },
    },
  ],
  webServer: [
    {
      command: "pnpm --filter @librarian/mcp-server serve",
      cwd: workspaceRoot,
      url: `${SERVER_URL}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        ...(process.env as Record<string, string>),
        LIBRARIAN_ADMIN_TOKEN: ADMIN_TOKEN,
        LIBRARIAN_DATA_DIR: DATA_DIR,
        LIBRARIAN_PORT: new URL(SERVER_URL).port || "3838",
        LIBRARIAN_TRPC_HOST: "0.0.0.0",
        LIBRARIAN_TRPC_PORT: new URL(TRPC_URL).port || "3840",
      },
    },
    {
      command: "pnpm --filter @librarian/dashboard start",
      cwd: workspaceRoot,
      url: DASHBOARD_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
      env: {
        ...(process.env as Record<string, string>),
        LIBRARIAN_ADMIN_TOKEN: ADMIN_TOKEN,
        LIBRARIAN_SERVER_URL: SERVER_URL,
        LIBRARIAN_TRPC_URL: TRPC_URL,
        LIBRARIAN_AUTH_CONFIG_TTL_MS: "1000",
      },
    },
  ],
});
