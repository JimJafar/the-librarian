import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": here,
    },
  },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    // The Server-Component renderToString tests run in plain Node; the
    // component-interaction tests under tests/components need a DOM, so
    // we pick jsdom there only. Vitest matches the glob top-down.
    environmentMatchGlobs: [
      ["tests/components/**", "jsdom"],
      ["tests/**", "node"],
    ],
    setupFiles: ["./tests/setup.ts"],
    passWithNoTests: true,
  },
});
