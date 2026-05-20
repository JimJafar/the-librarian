import { defineConfig } from "vitest/config";

// Root vitest config for cross-cutting tests that live at the repo
// root (healthcheck, integrations). Per-package configs continue to
// own their own tests; this picks up only `test/**/*.test.ts`.

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    passWithNoTests: true,
  },
});
