import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    server: {
      deps: {
        // Vite 5's SSR transformer can mangle `node:` built-in resolution
        // for native deps in the import chain. Externalise the @librarian/*
        // packages so Node's own loader handles the import chain.
        external: [/\/packages\/(core|mcp-server)\/(src|dist)\//],
      },
    },
  },
});
