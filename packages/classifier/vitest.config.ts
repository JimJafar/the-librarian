import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    passWithNoTests: true,
    // The classifier imports `@librarian/core`, which transitively touches
    // `node:sqlite` — Vite's SSR transformer drops the `node:` prefix when
    // resolving Node built-ins and fails. Externalising the core package
    // sends those imports through Node's own loader instead.
    server: {
      deps: {
        external: [/\/packages\/core\/(src|dist)\//],
      },
    },
  },
});
