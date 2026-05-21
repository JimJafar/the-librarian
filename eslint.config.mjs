// @ts-check
import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import vitest from "@vitest/eslint-plugin";
import importPlugin from "eslint-plugin-import";
import unicorn from "eslint-plugin-unicorn";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "**/data/**",
      "**/public/**",
      "**/next-env.d.ts",
      "pnpm-lock.yaml",
    ],
  },

  // Base JS recommended ruleset (applies to every file the flat config sees).
  js.configs.recommended,

  // Shared language options + plugin registration for JS/TS source.
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      import: importPlugin,
      unicorn,
    },
    settings: {
      "import/resolver": {
        node: { extensions: [".js", ".mjs", ".cjs", ".ts", ".tsx"] },
      },
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],

      "import/no-duplicates": "error",
      "import/newline-after-import": "error",
      "import/order": [
        "warn",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
          "newlines-between": "never",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],

      // Unicorn: opt-in to a small, useful subset. The rest of the plugin
      // is too opinionated for the existing JS; revisit when TS lands.
      "unicorn/prefer-node-protocol": "error",
      "unicorn/no-instanceof-builtins": "error",
    },
  },

  // TypeScript-specific rules. Applied via typescript-eslint flat presets so
  // both the parser and the plugin's recommended ruleset are wired up.
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
  })),
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-ignore": true,
          "ts-expect-error": "allow-with-description",
          "ts-nocheck": true,
          "ts-check": false,
          minimumDescriptionLength: 10,
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Use the TS-aware version; disable the base rule it supersedes.
      "no-unused-vars": "off",
    },
  },

  // Vitest plugin for test files (currently inert — tests are still
  // `node:test`; this lights up as suites migrate from Phase 3 onward).
  {
    files: ["**/*.{test,spec}.{js,ts,tsx}", "**/tests/**/*.{js,ts,tsx}"],
    plugins: { vitest },
  },

  // Next.js App Router lint rules, scoped to the dashboard so the rest of
  // the workspace doesn't pull in React/Web rules it doesn't need. Mirrors
  // `eslint-plugin-next`'s recommended + core-web-vitals rule sets in flat
  // form so T6.2+ lands under the full Next linter from day one.
  // `no-html-link-for-pages` is disabled: it targets the legacy Pages
  // Router which the dashboard never used.
  {
    files: ["apps/dashboard/**/*.{js,jsx,ts,tsx}"],
    plugins: { "@next/next": nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      "@next/next/no-html-link-for-pages": "off",
      // U3 — legacy `@/components/ui/*` (shadcn skin) was deleted. Block
      // future re-introduction; use `@/components/ui-v2/*` instead.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/components/ui/*"],
              message: "Use @/components/ui-v2/* — the legacy shadcn skin was removed in U3.",
            },
          ],
        },
      ],
    },
  },
);
