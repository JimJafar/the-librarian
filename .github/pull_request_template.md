<!--
The Librarian PR template (introduced in T1.4 of the maintainability overhaul).
Keep the sections; trim or expand the contents as the change requires.
-->

## Spec / phase reference

<!-- e.g. "Implements T1.4 — CI workflow + enforcement guards + PR template (Phase 1 of specs/done/002-maintainability-overhaul.md)" -->

## Summary

<!-- 1–3 bullets on what changed and why. Lead with the why. -->

-
-

## Test plan

<!-- Bulleted checklist proving the PR works. Reference the exact commands you ran. -->

- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm test:vitest`
- [ ] `pnpm build`
- [ ] `pnpm run smoke`
- [ ] `pnpm run healthcheck`
- [ ] Any task-specific verification commands from the spec

## Quality gates

- [ ] **No production source file over 400 LOC introduced** (or each exception noted with rationale below — applies to `packages/*/src/` and `apps/*/src/`, not tests)
- [ ] **No new `any` or `@ts-ignore` introduced** (or each exception noted with rationale below)
- [ ] **User-facing changes are documented in this PR** (CLI / MCP verbs / dashboard / install / harness setup / slash commands — or N/A for internal-only changes)

<!--
If you ticked an exception above, list each here:
  - path/to/file.ts (LOC: 612) — splitting deferred to T#.# because …
  - path/to/file.ts:42 — `any` retained because the third-party type is `unknown` and `…`
-->

## Notes for the reviewer

<!-- Anything reviewer-only: known follow-ups, deliberately-deferred work, screenshots, etc. -->
