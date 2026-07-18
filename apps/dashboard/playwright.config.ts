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
// pull the vault out from under the live server. CI passes its own dir via
// LIBRARIAN_E2E_DATA_DIR (runner.temp); local runs get a tmp-suffixed dir.
const E2E_DATA_DIR =
  process.env.LIBRARIAN_E2E_DATA_DIR ??
  path.join(os.tmpdir(), `librarian-e2e-${process.pid}-${Date.now()}`);
const E2E_SERVER_URL = process.env.LIBRARIAN_E2E_SERVER_URL ?? "http://127.0.0.1:3838";
// ADR 0008 P1/P3: the admin tRPC API no longer lives on the published agent
// port (E2E_SERVER_URL); it's on a SEPARATE internal listener. The dashboard
// and the e2e harness (global-setup + fixtures) must reach `/trpc` HERE, not on
// E2E_SERVER_URL (where it now 404s). The mcp-server webServer binds this; the
// dashboard webServer receives it as LIBRARIAN_TRPC_URL.
const E2E_TRPC_URL = process.env.LIBRARIAN_E2E_TRPC_URL ?? "http://127.0.0.1:3840";
const E2E_DASHBOARD_URL = process.env.LIBRARIAN_E2E_DASHBOARD_URL ?? "http://127.0.0.1:3000";

// Expose the resolved values back to tests + globalSetup.
process.env.LIBRARIAN_E2E_DATA_DIR = E2E_DATA_DIR;
process.env.LIBRARIAN_E2E_ADMIN_TOKEN = E2E_ADMIN_TOKEN;
process.env.LIBRARIAN_E2E_SERVER_URL = E2E_SERVER_URL;
process.env.LIBRARIAN_E2E_TRPC_URL = E2E_TRPC_URL;
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
        // Bind the internal tRPC listener where the dashboard + harness expect
        // it. Bind 0.0.0.0 so the harness (a sibling process) can reach it (prod
        // defaults to loopback). ADR 0008 P1.
        LIBRARIAN_TRPC_HOST: "0.0.0.0",
        LIBRARIAN_TRPC_PORT: new URL(E2E_TRPC_URL).port || "3840",
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
        // The default suite pins the public contract: proxy routes stay absent
        // unless a deployment explicitly opts into single-port mode.
        LIBRARIAN_SINGLE_PORT: "",
        // ADR 0008 P2: the dashboard reaches the admin tRPC API on the internal
        // listener, NOT the published agent port — without this it would fall
        // back to E2E_SERVER_URL/trpc (404) and every SSR tRPC call would hang.
        LIBRARIAN_TRPC_URL: E2E_TRPC_URL,
        // Short auth-config cache so globalSetup's config propagates within a test.
        LIBRARIAN_AUTH_CONFIG_TTL_MS: "1000",
        // Raise the credentials rate limit so the store-side LOCKOUT is what the
        // password spec exercises, not the dashboard throttle.
        LIBRARIAN_CREDENTIALS_RATE_LIMIT: "100",
      },
    },
  ],
});
