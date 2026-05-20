import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    passWithNoTests: true,
    // HTTP tests spawn the compiled bin and exercise the server via
    // real fetch calls. Give them a generous deadline and serialise the
    // worker pool so the child processes don't race on ports.
    testTimeout: 30000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    // Vite 5's SSR transformer drops the `node:` prefix when resolving
    // Node built-ins like `node:sqlite`. Externalize the core store +
    // local source/dist so Node's own loader handles the import chain.
    server: {
      deps: {
        external: [/\/packages\/core\/(src|dist)\//, /\/packages\/mcp-server\/(src|dist)\//],
      },
    },
  },
});
