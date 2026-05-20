# ADR 0003 — Ban `any` (and `@ts-ignore`) in production source

- **Status:** Accepted
- **Date:** 2026-05-20
- **Phase context:** Maintainability overhaul, Phase 1 (T1.4) and Phase 3 onward.

## Context

The Librarian started as plain JavaScript, then migrated to TypeScript during Phases 3–5 of the maintainability overhaul. During the port we explicitly decided that the value of TypeScript depends on never reaching for the escape hatches:

- `any` makes a value silently incompatible with every reachable type. One `any` in a hot helper can erode types across an entire module without a single TS error.
- `@ts-ignore` / `@ts-expect-error` silence the type checker at the line, not at the boundary. Used in production source they become technical debt nobody removes.

Without a hard rule, the temptation during a 30-PR overhaul was to use `any` "just for this PR" and never come back.

## Decision

In **production source** (`packages/*/src/`, `apps/*/src/`):

- `any` is banned. ESLint reports `@typescript-eslint/no-explicit-any` as an error.
- `@ts-ignore` and `@ts-expect-error` are banned. Comments suppressing TS errors are an error.
- `unknown` is the correct escape hatch — explicit, narrowable, and the compiler keeps tracking it.
- If a third-party library forces an awkward shape, write a small local typed adapter; do not leak `any` into call sites.

In **test code** (`packages/*/tests/`, `apps/*/tests/`, `test/`):

- One `any` is allowed *with an inline ESLint disable + rationale* when dealing with intentionally untyped JSON shapes (e.g. dynamic JSON-RPC responses in `callTool` helpers). Reviewers should still push back.
- `@ts-ignore` in tests stays banned — there's almost always a typed way.

The PR template requires the author to confirm "no new `any` or `@ts-ignore`" before merge. The 400-LOC quality gate complements this: long files are pressure to look the other way, so we keep production files small enough to read.

## Consequences

**Positive**

- The store layer (`@librarian/core`), MCP dispatch, tRPC procedures, and dashboard components are all typed end-to-end. Refactors propagate through the compiler instead of getting silently lost.
- Adding a new MCP tool, new tRPC procedure, or new dashboard form forces the author to think about the input shape rather than YOLOing through with `any`.
- When `unknown` does appear, it's a signal: a real boundary (JSON parsing, third-party SDK return value) that wants narrowing or a Zod parse right there.

**Negative**

- The first port of `dashboard.js` → `routes.ts` required writing several Zod schemas / explicit types where the old code accepted shapeless objects. That cost was real.
- A handful of test helpers carry an inline disable + comment. That's the agreed exception, but new tests do still occasionally need the same disable; reviewers must check that the comment explains *why*.
- Library upgrades that ship `any` in their `.d.ts` make us write tiny typed adapter layers. Worth it.

## Alternatives considered

- **`strict: true` only.** Rejected: `strict` accepts explicit `any` and `@ts-ignore`. We wanted those banned, not configured to compile.
- **Allow `any` in tests freely.** Rejected: tests are where regressions get caught; sloppy types in tests mask real shape changes.
- **Allow `any` in production with a TODO.** Rejected: TODOs in this layer have never been removed historically.

## Enforcement

ESLint flat config in `eslint.config.mjs`:

```js
"@typescript-eslint/no-explicit-any": "error",
"@typescript-eslint/ban-ts-comment": "error",
```

CI runs `pnpm run lint` on every PR; the workflow gates merge on a clean run. The PR template's "no new `any`/`@ts-ignore`" checkbox is an additional human gate.
