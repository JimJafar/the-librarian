import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Default to a Node environment; the extraction test opts into jsdom with a
    // per-file `// @vitest-environment jsdom` pragma (Defuddle's browser build
    // needs a real DOM).
    environment: "node",
    passWithNoTests: true,
  },
});
