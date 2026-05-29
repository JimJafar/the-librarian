# Spec: Dashboard redesign

## Status

Implemented 2026-05-21 (D1.0 in PR #52, D1.1 in PR #53, D1.2 in PR #54, D1.3 in PR #55, D1.4 in PR #56, D1.5 in this PR).

Each phase shipped narrowly against its own acceptance criterion. The
full editorial table rewrite, the three-tab view switcher, the per-row
inline KeyHints, and the deletion of `components/ui/` (the legacy
shadcn skin) were explicitly deferred — the spec's open question about
the licensed PP fonts also remains open. See `AUTONOMOUS-BUILD-NOTES-26-05-21.md`
for the cumulative follow-up list.

## Objective

Replace the current admin dashboard with one that's actually pleasant to use for the one person who uses it daily. Targets the **post-simplification end-state**, not the current code — memory and session state models are assumed to be three-state each (`active | proposed | archived`, `active | paused | ended`), and the dropped tools (`resolve_conflict`, `archive_session`, `restore_session`, `delete_session`, `delete_memory`) no longer exist.

**Three concrete fixes for the current pain:**

1. **Every filter is a dropdown populated from real data** — agent ids, project keys, harnesses, categories, source refs all come from `SELECT DISTINCT` over the corresponding column. No free-text filtering for known-value fields. Today's UI makes you type `claude-code` from memory.
2. **Bulk operations on memories** — multi-select rows, then re-home (change `agent_id` or `project_key`), archive, or batch-verify. Today the only way to act on N memories is N round-trips through the detail panel.
3. **A design with a point of view.** The current dashboard is a generic shadcn-ui layout; pleasant enough but anonymous. The redesign commits to an **editorial / archival** aesthetic that nods to library science without being kitsch — think New York Review of Books crossed with Linear, with IBM Plex Mono for technical strings.

**Success means:** finding all memories for a particular agent, picking the 12 that should be re-homed under a different `project_key`, and applying that change is **three clicks** (filter → multi-select → bulk action) and one keyboard shortcut to confirm. Not navigating to twelve detail pages.

## Non-goals

- **Not redesigning the data model.** The memory + session simplification specs own those changes. This spec consumes the post-simplification API.
- **Not building a CLI replacement.** The dashboard is for the human; the CLI + MCP tools are for agents and shells.
- **Not multi-user.** Single human operator. No auth gating beyond the admin token the dashboard already holds (the existing same-origin proxy + Server Actions pattern stays).
- **Not changing the framework.** Next.js 14 + Server Actions + browser tRPC stay. shadcn-ui primitives (Radix under the hood) stay for accessibility, but every visible surface is re-skinned — no leftover default shadcn look.
- **Not mobile-first.** Desktop primary. The interface is information-dense; tablet/desktop minimum. Mobile is best-effort, not a target.
- **Not building visualisations / analytics dashboards.** Counts and small spark-style indicators are fine; a Recharts-grade analytics surface is explicitly out of scope (already a decision from T6.4 — same call holds).

## Aesthetic direction

**The Librarian — editorial, archival, deliberate.**

The dashboard is the operator's workbench. Treat it like the inside cover of a well-bound reference work: confident typography, generous hairline rules, monospace accents for ids and timestamps that read like card-catalog strings, and a single saturated accent reserved for state that actually matters. Information dense where data lives, contemplative where the operator chooses an action.

### Typography

- **Display:** `PP Editorial New` (Pangram Pangram) — high-contrast serif with sharp angles. Used for page titles and the rare large numeric. Self-hosted via `next/font/local`.
- **Body / UI:** `PP Neue Montreal` (Pangram Pangram) — a grotesque with character without being trendy. Used for everything that isn't a heading or technical string.
- **Mono:** `IBM Plex Mono` (Google Fonts, free) — IDs (`mem_…`, `ses_…`), timestamps, status pills, recall queries, anywhere we're showing literal data the user might want to copy.

This pairing is intentional: an editorial serif for human language, a grotesque for navigation, a mono for machine strings. No `Inter`, no `Space Grotesk`, no `system-ui`.

### Colour

Two themes ship from day one — operator picks via toggle in the top bar.

**Light (Manuscript)** — default.

- Background: `#F5F1E8` (warm paper, not pure white)
- Foreground: `#1A1612` (dark ink, not pure black)
- Hairline rules: `#1A1612` at 12% opacity
- Surface (cards, panels): `#FAF7F0` (slightly lighter than background — creates layering without shadows)
- Mono background fill (id pills, query chips): `#EDE7D8`
- Accent — `Vermilion` `#D14B2A`. Used for: the single active state per view (selected row, current session, active tab), keyboard shortcut hints, the "unsaved changes" indicator. Nothing else.
- Subdued accent — `Sage` `#7B8B6F`. Used sparingly for: counts, progress, neutral state badges.

**Dark (Scriptorium)** — opt-in.

- Background: `#1C1814` (deep walnut)
- Foreground: `#E8E0D0` (candle-warm cream)
- Hairline rules: `#E8E0D0` at 14%
- Surface: `#231E18`
- Mono background fill: `#2A241D`
- Accent — `Saffron` `#E6A33D` (warmer than vermilion, reads better against the dark)
- Subdued accent — `Mossgreen` `#7A8B5C`

Both themes use the same component shapes, hairline weights, and spacing. Only the palette changes.

### Spatial composition

- **Three-column desktop layout.**
  - Left rail (≈ 220px): logo wordmark, primary nav (Memories / Sessions / Recall), theme toggle, settings.
  - Centre (fluid): the current surface. List / search / table.
  - Right inspector (≈ 420px, collapsible): detail of the currently selected row. Always-visible until the operator hits `[` to collapse it. Mirrors the Mail.app / Things 3 inspector pattern but with editorial chrome.
- **Information density:** tables are tight (28–32px row height, 13px body, 11px mono). Generous outer margins around tables to keep the eye relaxed.
- **Hairline rules over solid borders.** 1px at 12% opacity. No drop shadows except a single hairline-bottom on the top bar.
- **Asymmetry where it earns its keep.** The page title sits left, but the action toolbar floats right with a visible keyboard-shortcut hint per button. Filter chips run as a single horizontal row directly above the table, not a sidebar.
- **No card-soup.** The current dashboard wraps almost everything in shadcn `Card` components. The redesign uses cards only for inspectors. Lists are flat tables with hairline separators.

### Motion

Restrained. Editorial designs don't bounce.

- Page transitions: 180ms ease-out fade + 4px translate-y on the centre column only.
- Inspector open/close: 220ms ease-out width slide.
- Row select: instant background colour change (no transition — direct manipulation should feel direct).
- Cmd-K palette: 120ms backdrop fade, 160ms palette translate-y from -8px.
- Toasts: slide up from bottom, persist 3.5s, dismiss on click. One per action, never stacked.
- No looping animations, no skeleton shimmers (use a 1px progress bar at the top of the centre column instead — Linear-style).

Motion library: **`motion`** (the successor to Framer Motion). Already in the Next 14 ecosystem.

### Distinguishing details

The two things people will remember from this dashboard:

1. **The card-catalog tab.** The currently selected row gets a subtle vermilion 2px left edge that extends 6px outside the table — like a card pulled slightly out of a card-catalog drawer. Tiny detail, visible at any zoom.
2. **The mono everywhere it matters.** Every `mem_…` / `ses_…` id is a one-click copyable pill in IBM Plex Mono. Hover reveals a tiny `↵` glyph; click copies. Timestamps render as `2026‑05‑21 14:32` in mono. The dashboard doesn't hide that it's an admin tool over real data — it celebrates it.

## Information architecture

Three top-level surfaces. No tabs-within-tabs. The current dashboard's `(memories)` route group has a tab strip for analytics / proposals / conflicts / archive / logs — most of that consolidates here.

### 1. Memories

The biggest surface. Default landing page.

**Header strip** (above the table):

- Page title `Memories` (display serif, large).
- Primary action: `+ New memory` (vermilion outline button, keyboard `n`).
- View switcher: `All active` (default) · `Proposed` · `Archived`. Implemented as inline tabs, not a dropdown — three values, want them visible.
- Bulk-action bar appears in-place when ≥ 1 row selected: `Re-home` · `Archive` · `Verify as useful` · `Verify as outdated`. Vanishes on deselect.

**Filter row** (immediately above the table):

Faceted chip filters. **Every one of these is a dropdown populated from `SELECT DISTINCT` over the projection.** No free-text for any known-value field.

- Agent (multi-select)
- Project (multi-select)
- Category (multi-select; enum-backed, but the dropdown still reflects which categories actually have memories in the current scope)
- Visibility (`common` / `agent_private`)
- Priority (`core` / `high` / `normal` / `low`)
- Date range (created / updated, date picker)
- Usefulness score (range slider, `-3` to `+3`)
- Has duplicates (toggle — surfaces memories where `detectRelated.duplicates.length > 0` at last write)

A free-text search field at the right of the filter row covers title + body (FTS). It's the only text input on this page — every structured filter is a dropdown.

**The table:**

| Column | Sortable | Notes |
|---|---|---|
| Checkbox | — | Multi-select; click-and-drag to multi-select |
| Title | yes | Body line wraps once for context |
| Category | yes | Coloured pill (warmer for protected, neutral for others) |
| Agent | yes | Mono ID, click-to-filter |
| Project | yes | Mono key, click-to-filter |
| Score | yes | `usefulness_score` as 7 dots `· · · · · · ·` with vermilion fill from centre |
| Updated | yes | `2026‑05‑21 14:32` mono |
| ID | no | `mem_…` mono pill, click-to-copy |

Click a row → inspector opens. Double-click → opens in edit mode.

**Inspector for a memory:**

- Editable title (heading-style input).
- Editable body (textarea, monospace optional via toggle).
- Read-only metadata block: id, created/updated, agent, harness-of-origin, recall_count, usefulness_score.
- Verification feed: the last N `memory.verified` events with agent + result + note.
- Related memories: top 5 by `detectRelated` similarity ratio (post-simplification, no `seemsConflict` keyword junk). Each is a clickable row to switch focus.
- Actions: `Save` (only enabled if dirty), `Verify` (segmented: useful / not_useful / outdated), `Archive`, `Change agent`, `Change project`. The change-agent and change-project actions open small inline pickers — populated from the same dropdown data as the filter row.

**Re-home flow (the user's explicit ask):**

1. Filter by agent: select `claude-code` from the dropdown.
2. Select 12 memories with the checkbox column or click-drag.
3. Click `Re-home` in the bulk-action bar (or press `r`).
4. A modal: two dropdowns (new agent, new project), preview of "12 memories will move from `claude-code` / `the-librarian` → `codex` / `the-librarian`", confirm with `enter`.
5. Server Action calls a new bulk-update tRPC procedure. Single round-trip, single revalidatePath.

### 2. Sessions

Post-session-simplification, this is much simpler than today.

**Header strip:**

- Page title `Sessions`.
- Primary action: `+ Start session` (vermilion outline; keyboard `n`).
- View switcher: `Active` (default) · `Paused` · `Ended`. (Plus a count badge per tab.)

**Filter row:**

- Project (multi-select dropdown from data)
- Harness (multi-select dropdown from data)
- Cwd (multi-select dropdown from data)
- Created-by-agent (multi-select dropdown from data)
- Date range
- Free-text search over title + summaries + event content (FTS)

**Session list (centre):**

Editorial card stack — not a table. Each session is a vertically-stacked entry separated by a hairline rule:

- Display-serif title (large).
- Below: mono row of `project · harness · cwd · last activity`.
- Below that: the `rolling_summary` truncated to 3 lines with a soft fade.
- Below that: `next_steps[0]` if present, in italic with a `→` marker.
- Status indicator: vermilion left edge for the currently-selected session, sage edge for active, neutral for paused, no edge for ended.

Click → inspector opens. Inspector contains:

- Full metadata block (id, created/updated, paused_at, ended_at where applicable).
- The complete `next_steps` list, with `[ ]` checkboxes (cosmetic — clicking strikethroughs the line client-side; saving them as edits is a phase-2 nicety).
- Lifecycle actions row: `Checkpoint`, `Pause`, `End`, `Resume` (shown when status is `ended`).
- Handover preview accordion — paste-ready text in selected format (`prose` / `markdown` / `claude` / `codex` / `opencode` / `hermes` / `pi`).
- Promote-memory form: pick from session content / candidate_memories, route into the memory store.
- Event stream: chronological with type, summary, agent, harness. Filterable by type. The two queued component tests (LifecycleActions interaction + `startTransition(async)` pending regression from TODO #17) target this surface.

### 3. Recall

Currently lives under `Memories → Logs` and is half-baked. Promote to a top-level surface.

**Header strip:**

- Page title `Recall`.
- Date range picker (default last 7 days).

**Two-pane layout:**

- **Left: query timeline.** A scrolling list of recall events. Each row: timestamp, query text (mono), result-count, agent. Empty-recall events (`memory.recall_empty`) are marked with a vermilion dot.
- **Right: pinned to selected row.** The exact memories returned for that recall (ranked), with their then-current `usefulness_score`. If the query returned empty, the right pane shows "no matches" plus a `Create memory for this query` shortcut that opens the new-memory inspector pre-populated.

**Insights strip at the top:**

Three small stats (no chart library):

- Recalls in window
- Empty-recall rate
- Top 3 queries (most-frequent) with their hit/empty ratio

These are inline text with sage accents, not Recharts cards.

## Keyboard model

Keyboard is first-class. Every action has a shortcut. A `?` overlay maps them all.

**Global:**

- `cmd-k` — command palette (search any memory/session, jump to nav, invoke any action)
- `cmd-/` — toggle inspector
- `g` then `m` / `s` / `r` — jump to Memories / Sessions / Recall
- `?` — show shortcuts overlay
- `cmd-,` — settings (theme, token management, etc.)

**List context (Memories or Sessions):**

- `j` / `k` — next / previous row
- `enter` — open in inspector
- `e` — open in edit mode
- `x` — toggle row selection
- `shift-x` — range-select from anchor
- `a` — archive (memories) / end (sessions)
- `v` — verify (memories) — followed by `u` / `n` / `o` for useful / not_useful / outdated
- `r` — re-home (memories, when ≥ 1 selected) / resume (sessions, when ended is focused)
- `/` — focus search

**Inspector context:**

- `[` — collapse inspector
- `cmd-s` — save (when dirty)
- `esc` — close inspector / cancel edit

The shortcuts overlay shows all of these grouped by context. Inline shortcut hints render in vermilion next to each button (e.g. `Archive  a`).

## Tech notes

- **Framework:** Next.js 14 (App Router) — kept.
- **Component primitives:** Radix UI (via shadcn) — kept under the hood for accessibility (Dialog, Dropdown, Tabs, Tooltip, Combobox, etc.). All visible styling re-skinned via a new `components/ui-v2/` directory; the existing `components/ui/` is deleted once this spec ships.
- **State:** Server Components for reads, Server Actions for writes (kept). Browser tRPC for any read that needs to update without a navigation (kept).
- **Forms:** `react-hook-form` + Zod (new). The current dashboard uses raw form state; forms in the redesign are non-trivial enough (re-home modal, change-agent inline, promote-memory) to want validation primitives.
- **Tables:** `@tanstack/react-table` for the Memories table (new). Sort, multi-select, click-drag selection, column resize all benefit from the primitive. Kept invisible — only its hooks, the markup is hand-rolled to match the aesthetic.
- **Motion:** `motion` (new — successor to Framer Motion).
- **Fonts:** PP Editorial New + PP Neue Montreal self-hosted via `next/font/local`; IBM Plex Mono via `next/font/google`. Licences: PP fonts require purchase per workstation for production use — operator (Jim) confirmed acceptable, or fall back to a free serif (e.g. `Newsreader` for body, `Fraunces` for display) before ship if not.
- **Icons:** `lucide-react` for utility icons; no custom illustration. Editorial design is restrained — icons don't carry the personality, typography does.
- **Bulk-update tRPC procedure (new):** `memories.bulkUpdate({ ids: string[], patch: { agent_id?, project_key? } })`. Server-side validation: only `agent_id` and `project_key` are settable in bulk. Other fields go through the per-memory `memories.update`.
- **Distinct-values tRPC procedures (new):** `memories.distinctValues({ field })` and `sessions.distinctValues({ field })`. Return the deduplicated set of values for the named column, scoped to non-archived data by default. Cached client-side per session via React Query, invalidated on any write to the corresponding store.

## Migration plan (phases)

Lands after the memory + session simplification specs. Each phase is one PR. Each phase leaves `main` releasable.

### Phase 0 — Design system foundations (D1.0)

Pure setup. No user-visible change to the existing dashboard yet.

- Add fonts (`apps/dashboard/app/fonts/` for PP licensed files; `next/font/google` for IBM Plex Mono).
- Build the colour-token CSS (`apps/dashboard/styles/tokens.css`) with both themes via `[data-theme="light"]` / `[data-theme="dark"]`.
- Theme toggle in the existing layout. Stored in localStorage; SSR-safe via a small inline script.
- New `components/ui-v2/` directory scaffolded with: `Button`, `Pill` (the mono id chip), `Hairline`, `Inspector` (right-panel container), `CommandPalette` (cmd-k skeleton, no contents yet), `FilterChip`, `KeyHint`.
- Storybook? — no. Avoid the tooling burden; the redesign is for one operator, not a component library.

**Acceptance:** the theme toggle works on the existing dashboard pages with the new colour tokens applied to body background + foreground only (so the rest of the app still looks like today, just on a warm paper background — proves the tokens flow). `components/ui-v2/` exists with stub components and one snapshot test per.

### Phase 1 — Memories surface (D1.1)

The big one. Replace `apps/dashboard/app/(memories)/page.tsx` and its sub-routes.

- New centre column for Memories: three-tab view switcher (`All active` / `Proposed` / `Archived`), filter row with data-driven dropdowns, table with multi-select.
- Inspector (right panel) for memory detail + edit + verify + change-agent / change-project actions.
- New tRPC procedures: `memories.distinctValues`, `memories.bulkUpdate`. Tests for both.
- Re-home modal flow as specified.
- Bulk-action bar appears when ≥ 1 row selected.
- Delete the old `(memories)/{analytics,proposals,conflicts,archive,logs}` route group sub-pages. Their content either moves into the new tabs (proposals, archive) or to the new Recall page (logs) or is dropped entirely (conflicts — gone post-memory-simplification; analytics — out of scope per non-goals).
- Component tests target the table (selection model), the filter dropdowns (data-driven population), and the re-home modal (validation + Server Action wiring).
- Playwright e2e for the golden-path re-home flow.

**Acceptance:** the Memories page is the new design end-to-end. Filtering by agent populates a dropdown from data, not free text. Selecting 12 rows and re-homing them via the modal results in one tRPC round-trip and twelve updated rows.

### Phase 2 — Sessions surface (D1.2)

- New centre column for Sessions: three-tab view switcher (`Active` / `Paused` / `Ended`), filter row, editorial card stack.
- Inspector for session detail + lifecycle actions + handover preview + promote-memory + event stream.
- New tRPC procedure: `sessions.distinctValues`. Tests.
- The two queued component tests from TODO #17 (LifecycleActions interaction + `startTransition(async)` pending regression) land here.
- Update Playwright e2e for the new session surface.

**Acceptance:** Sessions page is the new design. Filtering by harness populates from data. Resume on an ended session is visible (per session-simplification).

### Phase 3 — Recall surface (D1.3)

- Promote `Recall` to a top-level nav item.
- Two-pane layout: query timeline + selected-recall detail.
- Empty-recall handling with "create memory for this query" shortcut.
- Insights strip (three stats, plain text).
- The old `(memories)/logs/page.tsx` route is removed once feature parity is confirmed.

**Acceptance:** Recall is its own top-level surface. Selecting a recall in the timeline pins its memories to the right pane. Empty-recall rate is visible in the insights strip.

### Phase 4 — Keyboard + command palette (D1.4)

- Implement the full keyboard model.
- Command palette (`cmd-k`) with: search any memory/session by title, jump to a nav surface, invoke any registered action.
- `?` shortcuts overlay.
- Inline `KeyHint` rendering on every primary button.
- All actions registered through a single `actions.ts` registry so the palette can enumerate them.

**Acceptance:** every action documented in the keyboard model section works via keyboard alone. `cmd-k` is the fastest way to reach any memory or session by title.

### Phase 5 — Polish + cleanup (D1.5)

- Delete `apps/dashboard/components/ui/` (the old shadcn skin). Migrate any leftover imports.
- Performance pass: ensure the Memories table renders 1,000 rows without virtualisation issues; the inspector edit form has no jank on type.
- A11y pass: focus rings, ARIA on the Combobox-style filter dropdowns, contrast verified against WCAG AA for both themes.
- README + CONTRIBUTING update for "new dashboard page" recipe (new section names, new component primitives directory).
- `TODO.md`: mark items #15 (UI redesign), #16 (simplification — the dashboard half), and #17 (more component tests, less Playwright) as resolved.
- `specs/007-dashboard-redesign.md` (this file) status → "Implemented YYYY-MM-DD".

**Acceptance:** stranger walkthrough — sit a new contributor in front of the dashboard, ask them to find all memories for a given agent and archive the three oldest. Should take under 30 seconds without help.

## Summary

| Phase | PR | What |
|---|---|---|
| 0 | D1.0 | Design system foundations (fonts, tokens, theme toggle, `ui-v2/` scaffold) |
| 1 | D1.1 | Memories surface (table, filters, bulk re-home, inspector) |
| 2 | D1.2 | Sessions surface (card stack, lifecycle, handover, promote) |
| 3 | D1.3 | Recall surface (timeline + pinned detail + insights) |
| 4 | D1.4 | Keyboard model + command palette |
| 5 | D1.5 | Polish, cleanup, docs |

6 PRs, serial. Each leaves `main` releasable. Phase 0 ships first; existing pages keep working on the new tokens. Phases 1–3 replace pages one at a time; the centre column changes but the layout chrome (nav rail, top bar) is consistent throughout.

## Open questions

- **Licensed display font.** PP Editorial New + PP Neue Montreal require purchase per workstation. Single-operator deployment so it's a one-off cost — but if you'd rather stay on free fonts, the fallback pair is `Fraunces` (display) + `Newsreader` (body), both via `next/font/google`. Decide before D1.0 lands.
- **Token-management UI inside the dashboard.** Spec'd in TODO #14. Where does it sit — Settings (under `cmd-,`) or a top-level surface? Lean: Settings. Outside this spec; future addition.
- **Should the `Recall` surface include a "memories never recalled" view?** Interesting maintenance signal — but adds a fourth surface. Lean: no for now, add later if it earns its keep.

## Acceptance review (for this spec)

- Are dropdowns-from-data feasible for fields with high cardinality? — Yes; the `distinctValues` tRPC procedure caches client-side, and personal-scale memory counts (single-digit thousands) keep the distinct sets small. Re-evaluate if a column ever crosses ~500 distinct values; until then, no virtualisation needed in the dropdowns.
- Is the editorial direction at odds with information density? — The two are reconciled by the typography pairing: serif for headings + grotesque for UI + mono for technical strings. Density lives in the table; restraint lives in the inspector and headers.
- Does the bulk re-home flow need an undo? — Lean yes for v2; the bulk-update emits one `memory.bulk_updated` event per memory, so a separate `memories.bulkRevert(transaction_id)` is feasible. Out of scope for D1.1; add if needed once usage warrants.
