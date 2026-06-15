---
target: /memories
total_score: 24
p0_count: 1
p1_count: 3
timestamp: 2026-06-15T08-32-47Z
slug: apps-dashboard-components-memories-view-tsx
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Loading state is plain text ("Loading memories…") — the new MemoryOrb / pending dot vocabulary the vault uses isn't here yet. |
| 2 | Match System / Real World | 3 | "Recall" is a domain verb that wants a hover affordance — currently just a heavy grey button. |
| 3 | User Control and Freedom | 3 | Filter sidebar has Recall but no "clear filters" — only an implicit reset via empty fields. Recall results banner has a Clear, which is good. |
| 4 | Consistency and Standards | 1 | The whole surface is pre-redesign chrome: native `<select>`s, native date inputs, rounded card rows, `text-muted-foreground`, `text-2xl font-semibold tracking-tight` h1, `bg-muted/30` sidebar fill, grey-solid Recall button. Sits side-by-side with the vault's full editorial treatment — they look like different products. |
| 5 | Error Prevention | 3 | Date inputs are constrained by the native picker; the bulk re-home flow has a modal confirmation. Good. |
| 6 | Recognition Rather Than Recall | 3 | Distinct-values dropdowns are populated from the DB — operator doesn't have to type `claude-code` from memory. Good. |
| 7 | Flexibility and Efficiency | 1 | Zero keyboard shortcuts. The handoff plan calls for `/` filter, `N` new memory, `J/K` row cycle, `R` recall — none wired. The whole surface only works mouse-first. |
| 8 | Aesthetic and Minimalist Design | 2 | Rounded shadcn cards on warm paper read as Vercel admin, not the Reading Room. h1 in `font-semibold` sans, no Fraunces. The figure / verdigris / copper / hairline vocabulary from the vault is entirely absent here. |
| 9 | Error Recovery | 3 | Errors render as `border-destructive/50 bg-destructive/10` callouts — clear enough, though the styling is shadcn-default rather than editorial. |
| 10 | Help and Documentation | 2 | No contextual help, no shortcut hint, no inline explanation of Recall vs Search. The `?` overlay is global, but it won't show any Memories shortcuts (because none are bound). |
| **Total** | | **24/40** | **Acceptable** — significant rework needed to align with rc.15. |

## Anti-Patterns Verdict

**LLM assessment**: not AI slop in the cliché sense — no gradient text, no glassmorphism, no hero-metric template. What it is is the dashboard-redesign baseline state: standard shadcn admin chrome that worked fine before Phase 1 set a higher bar. The biggest tell now is inconsistency with the vault: an operator who toggles between `/vault` and `/` sees two completely different products.

**Deterministic scan**: `detect.mjs --json` on the memories source tree returned `[]` (no matches). Drift here is editorial-system-vs-shadcn-default, which the rule set doesn't directly encode.

## Overall Impression

The surface works. Filters, sort, bulk re-home, recall, modal detail panel, pagination — correct, considered, tested. What's missing is the redesign system, end-to-end. After spending Phase 1 building verdigris-copper-hairline-Fraunces-Newsreader-KeyHint-EmptyState-MemoryOrb-glow-vault-prose, none of it appears on the route operators visit most often.

## What's Working

- **Data-driven filter dropdowns** (`MemoriesFilters` calling `memories.distinctValues`) — operator never types `claude-code` from memory.
- **Bulk-select + re-home modal** — confirmation-protected bulk action, accumulated state across pages, indeterminate select-all.
- **Recall vs. Search separation** — `filterClientSide()` does cheap substring filter, `recallAction()` calls the ranker.

## Priority Issues

- **[P0] Whole-surface system drift** — every chrome element on `/memories` is pre-rc.15 vocabulary. Reads as a different product from `/vault`. Suggested: `/impeccable polish /memories`.
- **[P1] Card rows duplicated four times** — `list.tsx`, `simple-list.tsx`, `flagged-view.tsx`, `archive-view.tsx`. Suggested: `/impeccable extract /memories`.
- **[P1] No keyboard shortcuts** on the operator's most-used route. Suggested: `/impeccable harden /memories`.
- **[P1] Recall button reads as disabled** — solid medium-grey on warm paper, no rubric. Suggested: covered by `polish`.
- **[P2] Date inputs are native browser pickers** — defer to Phase 3 backlog.

## Persona Red Flags

**Alex (Power User)** — no keyboard shortcuts; would try `/` and `j/k` and find nothing wired. ⌘K palette has the route but Recall is mouse-only.

**Sam (Accessibility-Dependent)** — focus state on new-memory button works (rc.15 Button); native `<select>` keyboard-navigates fine; bulk-select checkboxes are unstyled natives; error messages lack `role="alert"`. Passable, not exemplary.

## Minor Observations

- Mobile stacks the filter sidebar above the list via generic `<details>`.
- "Score (clamped ±3)" lives in a `title` — not discoverable to keyboard users.
- "Re-home (N)" bulk action uses `variant="primary"` which conflicts with the One Pen Rule.
- Toast is bespoke; could be a future extract.

## Questions to Consider

- Filter sidebar → row of `FilterChip`s above the list to free horizontal space?
- Detail panel modal → right-rail `Inspector` so the list stays visible?
- Two visibly different affordances for Search vs Recall?
