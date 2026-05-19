import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    passWithNoTests: true,
    // Vite 5's SSR transformer drops the `node:` prefix when resolving Node
    // built-ins like `node:sqlite`, which then fail to load. Externalize the
    // store module so Node's own loader handles the import chain.
    server: {
      deps: {
        external: [/\/packages\/core\/src\//],
      },
    },
  },
});
