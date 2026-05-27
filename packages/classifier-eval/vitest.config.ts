import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    passWithNoTests: true,
    server: {
      deps: {
        external: [/\/packages\/core\/(src|dist)\//],
      },
    },
  },
});
