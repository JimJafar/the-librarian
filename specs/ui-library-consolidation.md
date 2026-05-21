# Spec: UI library consolidation — delete `components/ui/`

## Status

Drafted 2026-05-21. Three serial PRs (U1, U2, U3).

## Objective

Eliminate the legacy shadcn skin (`apps/dashboard/components/ui/`) and consolidate the dashboard on the editorial design system (`apps/dashboard/components/ui-v2/`) introduced in D1.0. Today the dashboard maintains two parallel atom libraries — every new component has to choose between them, and the two are visually inconsistent.

**The current state.**

- `components/ui/` (legacy shadcn): `badge`, `button`, `card`, `dialog`, `input`, `table`, `tabs`. Generic Vercel-template styling. 16 files import from it.
- `components/ui-v2/` (editorial, from D1.0): `button`, `command-palette`, `filter-chip`, `hairline`, `inspector`, `key-hint`, `pill`. The intended design system. Missing equivalents for `dialog`, `input`, `table`, `tabs`, and `card`.

D1.5 was meant to delete the legacy directory but deferred — the 16-file blast radius needed more care than the autonomous run had budget for, and `ui-v2/` was missing too many atoms for a single-PR migration.

**Success means:** `apps/dashboard/components/ui/` does not exist; every dashboard surface uses `ui-v2/` atoms exclusively; an ESLint rule prevents the legacy path from being re-introduced; both themes (Manuscript, Scriptorium) render correctly on every surface.

## Non-goals

- **Not changing component behaviour.** The migration is visual + structural. Memories list still filters, sessions detail still renders the timeline, recall still pages. Behaviour parity is the bar.
- **Not redesigning surfaces.** The editorial table rewrite, three-tab Memories view switcher, and Sessions card stack are explicitly deferred (in the dashboard-redesign open items list). This spec migrates the *existing* surfaces onto the new atoms; the redesign of those surfaces is a separate effort.
- **Not changing the dialog accessibility primitive.** Both `ui/dialog.tsx` and the hand-rolled wrapper in `components/memories/rehome-modal.tsx` use Radix Dialog under the hood. The editorial `ui-v2/dialog.tsx` keeps Radix; only the visual shell changes.
- **Not introducing Storybook.** A dedicated component playground would be nice for the new atoms but is out of scope here — the existing component tests + visual smoke in the local dashboard are sufficient.
- **Not migrating off Tailwind.** The `ink-*` token namespace introduced in D1.0 stays; new atoms consume the same tokens.

## Decisions (resolved)

- **Three serial PRs.** The work decomposes cleanly into "build missing atoms → migrate the heavy surface (Sessions) → migrate the rest and delete". Each PR leaves `main` releasable and the system in a coherent state — never half-migrated.
- **Build atoms first, migrate after.** Mixing atom-construction with call-site migration in one PR makes review impossible. U1 (atoms) is reviewed for design quality; U2 / U3 are reviewed for migration correctness.
- **`card` is replaced by `inspector` for the inspector role and by hairline-bounded sections elsewhere — no new `ui-v2/card.tsx`.** The dashboard-redesign spec explicitly called out "no card-soup"; preserving a generic Card atom would invite regression.
- **The `badge` migration goes to `pill`.** They have the same role (small inline status indicator); `ui-v2/pill.tsx` already exists.
- **ESLint `no-restricted-imports` rule** is added in U3 alongside the deletion. The rule pattern is `@/components/ui/*`; the message is "Use `@/components/ui-v2/*` — the legacy shadcn skin was removed in U3."
- **`rehome-modal.tsx`'s hand-rolled dialog wrapper** consolidates into `ui-v2/dialog.tsx` in U1 and is removed when `rehome-modal.tsx` is migrated in U3.

## Tech stack

No new dependencies. Existing stack:

- **Radix UI** for accessibility primitives (Dialog, Tabs) — already in use.
- **Tailwind + the `ink-*` token palette** from D1.0.
- **`motion`** library for any transitions on the new atoms — already in `package.json` from D1.0.
- **`class-variance-authority` (cva)** for variant management — already used in `ui-v2/button.tsx`.

## Migration plan (phases)

### Phase 1 — Build missing `ui-v2` atoms (U1)

Build the editorial replacements that don't yet exist. No call-site migration in this PR; the new atoms ship and are exercised by unit tests + a single demo route gated behind `NEXT_PUBLIC_UI_V2_DEMO=1` (or similar) for visual review.

**New atoms:**

- **`ui-v2/dialog.tsx`** — Radix Dialog wrapper.
  - Editorial chrome: serif title (Fraunces / Newsreader), hairline rule below header, `ink-surface` background, generous padding, `motion` slide-up entrance per the dashboard-redesign motion spec.
  - API: `<Dialog open onOpenChange><DialogTrigger /><DialogContent><DialogHeader><DialogTitle /><DialogDescription /></DialogHeader>...<DialogFooter /></DialogContent></Dialog>`. Mirrors the existing Radix shape.
  - Subsumes the hand-rolled wrapper in `rehome-modal.tsx`.
- **`ui-v2/input.tsx`** — text input.
  - Hairline bottom border (no full box), `ink-foreground` text, monospace variant via `variant="mono"` for technical strings (ids, timestamps).
  - Variants: `default`, `mono`. Sizes: `sm`, `md`.
  - Standard `<input>` props pass through.
- **`ui-v2/table.tsx`** — editorial table primitive.
  - 28–32px row height (per dashboard-redesign spec), 13px body / 11px mono, hairline row separators at 12% opacity, no card chrome.
  - Sub-components: `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell`. Selection state surfaces via `data-selected` on `TableRow` (used by future bulk-action surfaces).
  - No built-in sort UI — sort is owned by the consuming surface.
- **`ui-v2/tabs.tsx`** — Radix Tabs wrapper.
  - Editorial chrome: vermilion / saffron underline on the active tab (theme-dependent), hairline separator beneath the tab strip, mono labels.
  - API mirrors Radix: `<Tabs><TabsList><TabsTrigger /></TabsList><TabsContent /></Tabs>`.

**Tests (U1):**

- One unit test per new atom asserting render + variant prop handling.
- Snapshot of the demo route in both themes (Manuscript, Scriptorium).
- No changes to existing component tests in this PR.

**Acceptance (U1):**

- `ui-v2/` contains `button`, `command-palette`, `dialog`, `filter-chip`, `hairline`, `input`, `inspector`, `key-hint`, `pill`, `table`, `tabs` (11 atoms).
- Each new atom renders in the demo route in both themes; visual review confirms editorial direction holds.
- `pnpm test --filter @librarian/dashboard` passes; `pnpm build` passes; `pnpm lint` passes.
- No imports from `@/components/ui/*` were added or removed in this PR.

### Phase 2 — Migrate Sessions surface (U2)

Sessions has the largest concentration of legacy imports (6 files: `detail-view`, `events-stream`, `handover-form`, `lifecycle-actions`, `list-view`, `promote-form`). Migrating it in one PR keeps the review coherent — every test that touches Sessions runs against a consistent atom set.

**For each Sessions component file:**

- Replace `@/components/ui/button` → `@/components/ui-v2/button`. Prop API is compatible; size / variant names match.
- Replace `@/components/ui/input` → `@/components/ui-v2/input`. Same prop shape.
- Replace `@/components/ui/table` → `@/components/ui-v2/table`. Sub-component names match.
- Replace `@/components/ui/badge` → `@/components/ui-v2/pill`. Verify each badge call site picks the appropriate `pill` variant (`default`, `accent`, `muted`).
- Replace `@/components/ui/card` → hairline-bounded section (`<section class="border-t border-ink-hairline pt-4 …">`) or `ui-v2/inspector` if the role is "detail panel". Decide per call site.
- Replace `@/components/ui/dialog` → `@/components/ui-v2/dialog`. Subsume any local `motion` wrappers into the new atom.
- Replace `@/components/ui/tabs` → `@/components/ui-v2/tabs`.

**Tests (U2):**

- Existing Sessions component tests adjusted for any prop-name divergences.
- Existing Playwright sessions e2e specs unchanged (selectors should be role-based, not class-based — adjust any that aren't).
- Visual smoke: walk the Sessions list, a session detail, the handover form, and the lifecycle actions in both themes.

**Acceptance (U2):**

- `rg "@/components/ui/" apps/dashboard/components/sessions/` returns zero hits.
- All existing Sessions tests pass.
- Playwright `sessions-*` specs pass.
- No regression in cmd-K, recall, or Memories — those weren't touched.

### Phase 3 — Migrate Memories + recall + theme-toggle + delete (U3)

The remaining 10 files: `theme-toggle`, `recall/view`, `memories/{filters, simple-list, detail-panel, rehome-modal, logs-view, list, new-form, view}`.

**For each file:**

- Same per-import replacements as U2.
- `rehome-modal.tsx` specifically — drop its hand-rolled dialog wrapper, consume `ui-v2/dialog.tsx` directly.

**Delete:**

- `rm -rf apps/dashboard/components/ui/`.

**Guard:**

- Add to `apps/dashboard/.eslintrc.*` (or top-level eslint config if it lives there) a `no-restricted-imports` rule:
  ```js
  "no-restricted-imports": ["error", {
    patterns: [{
      group: ["@/components/ui/*"],
      message: "Use @/components/ui-v2/* — the legacy shadcn skin was removed in U3."
    }]
  }]
  ```

**Tests (U3):**

- Existing Memories + recall component tests adjusted as in U2.
- Existing Playwright `memories-*`, `recall-*` specs pass.
- ESLint rule firing test: a deliberate `import { Button } from "@/components/ui/button"` in a scratch file should fail `pnpm lint`. (Don't commit the scratch — verify locally.)

**Acceptance (U3):**

- `apps/dashboard/components/ui/` does not exist.
- `rg "@/components/ui/" apps/dashboard` returns zero hits.
- `pnpm lint` enforces the restriction.
- All component tests + Playwright e2e pass.
- Both themes render correctly across Memories, Sessions, Recall, and the cmd-K palette.

## Summary

| Phase | PR | What | Files touched |
|---|---|---|---|
| 1 | U1 | Build `dialog`, `input`, `table`, `tabs` in `ui-v2/` | 4 new files + tests + demo route |
| 2 | U2 | Migrate Sessions surface | 6 files in `components/sessions/` |
| 3 | U3 | Migrate Memories + recall + theme-toggle, delete `ui/`, add ESLint guard | 10 files + 7 deletions + 1 ESLint rule |

3 PRs, serial. Each leaves `main` releasable.

## Open questions

- **Storybook-equivalent demo route.** U1 ships a one-off demo route to make atom review tractable. Delete it in U3, or keep it as a permanent design-system playground? — Leaning delete; the local dashboard surfaces are the real consumers and a perpetual demo route is dead weight.
- **`badge` → `pill` variant matrix.** The legacy `Badge` has more variants (`default`, `secondary`, `destructive`, `outline`) than `Pill` currently does. Audit the call sites in U2; either expand `Pill`'s variants or have call sites pick the closest editorial equivalent. Likely the latter — editorial designs are restrained — but worth checking that `destructive` doesn't lose information at a critical call site (e.g., an archived-state badge).
- **Visual regression tooling.** Currently the dashboard has no Percy / Chromatic equivalent. Worth investing in one alongside this work, or rely on manual smoke + Playwright screenshots-on-failure? — Out of scope here; the manual smoke is sufficient for one operator. Revisit if the surface area grows.
- **`ui-v2/card.tsx` reversal.** If U2 / U3 keep needing a card primitive in places `inspector` doesn't fit, that's signal we need it. Track during migration; build in a follow-up PR if so, rather than expanding U1.

## Acceptance review (for this spec)

- **Does deleting `components/ui/` risk an unrelated regression?** Possible but contained. The `no-restricted-imports` rule plus full test + Playwright run + manual two-theme walkthrough should catch any. Worst case is a missed call site — easy to revert one file's import or add the missing `ui-v2` atom.
- **Why not migrate everything in one big PR?** Reviewer fatigue. 16 files × 2–4 import changes each + 4 new atoms + 1 deletion + 1 ESLint rule is too much for a single review session to be useful.
- **Is the editorial direction stable enough to commit to?** Yes — D1.0 through D1.4 already shipped against it and the operator has used the surfaces. The atoms in U1 are the same primitives the editorial dashboard already uses, just exposed as reusable building blocks.
