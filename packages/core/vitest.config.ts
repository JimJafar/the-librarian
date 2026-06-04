import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    passWithNoTests: true,
    // Vite 5's SSR transformer can mangle `node:` built-in resolution for native
    // deps in the import chain. Externalize the store module (both source and
    // built output) so Node's own loader handles it.
    server: {
      deps: {
        external: [/\/packages\/core\/(src|dist)\//],
      },
    },
  },
});
