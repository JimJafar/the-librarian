import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    server: {
      deps: {
        // Vite 5's SSR transformer drops the `node:` prefix when resolving
        // Node built-ins like `node:sqlite`. Externalise the @librarian/*
        // packages so Node's own loader handles the import chain.
        external: [/\/packages\/(core|mcp-server)\/(src|dist)\//],
      },
    },
  },
});
