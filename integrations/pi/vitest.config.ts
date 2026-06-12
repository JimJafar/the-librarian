import { defineConfig } from "vitest/config";

// The schema-parity drift guard imports the compiled @librarian/mcp-server
// (and through it @librarian/core). Vite 5's SSR transformer drops the
// `node:` prefix when resolving Node built-ins inside that tree, so —
// exactly like the root vitest.config.ts — externalize the workspace
// packages and let Node's own loader handle them.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    server: {
      deps: {
        external: [/\/packages\/core\/(src|dist)\//, /\/packages\/mcp-server\/(src|dist)\//],
      },
    },
  },
});
