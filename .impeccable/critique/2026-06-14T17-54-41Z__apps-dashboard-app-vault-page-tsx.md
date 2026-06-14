---
target: /vault
total_score: 26
p0_count: 1
p1_count: 2
timestamp: 2026-06-14T17-54-41Z
slug: apps-dashboard-app-vault-page-tsx
---
# Critique — `/vault` (Vault explorer)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | File selection is a full navigation with no loading state; current mode (view/edit/history) barely indicated. |
| 2 | Match System / Real World | 3 | Strong domain language — vault, wikilinks, backlinks, frontmatter→"Properties", primer. |
| 3 | User Control and Freedom | 3 | Cancel everywhere; compare-and-swap blocks silent overwrite; delete/restore are git-recoverable and say so. |
| 4 | Consistency and Standards | 2 | Patchwork: editorial `ui-v2` chrome over legacy shadcn content cards; hand-rolled badge instead of `Pill`; buttons instead of `Tabs`. |
| 5 | Error Prevention | 3 | Confirm dialogs, schema validation on save, live byte cap, conflict detection. |
| 6 | Recognition Rather Than Recall | 3 | Tree, path, backlinks all visible; but mode state and shortcuts are not surfaced. |
| 7 | Flexibility and Efficiency | 2 | No keyboard shortcuts, no tree filter/search, full-page nav per file; `KeyHint` unused. |
| 8 | Aesthetic and Minimalist Design | 2 | Clean but unfinished — shadcn cards + dead `prose` classes make the reading surface generic and typographically thin. |
| 9 | Error Recovery | 3 | Inline `role="alert"` errors, teaching copy, conflict-as-error. |
| 10 | Help and Documentation | 3 | Dialog descriptions genuinely teach; empty state explains what lives in the vault. |
| **Total** | | **26/40** | **Acceptable — solid, safe, well-taught; visually mid-migration and not yet keyboard-efficient.** |

## Anti-Patterns Verdict

**Does this look AI-generated?** Not in the slop-trope sense — but yes in the "generic admin template" sense, which is exactly what the redesign exists to escape.

- **LLM assessment:** No gradient text, no glassmorphism, no eyebrow kickers, no hero-metric cards, no side-stripes. The tells here are subtler: every *content* container is a `rounded-md border bg-card` shadcn panel with `text-muted-foreground` labels. The action chrome (Button/Dialog/Input) is on the editorial `ui-v2` system, but the panels the operator actually reads — markdown article, Properties, Backlinks, history list, diff — are stock shadcn. It reads as "a competent shadcn admin," not "The Reading Room."
- **Deterministic scan:** `detect.mjs` → `[]` (exit 0, clean). Zero trope hits. This corroborates the LLM read: the problem isn't a bannable pattern, it's design-system drift the trope detector can't see. Confirmed separately: `@tailwindcss/typography` is not a dependency and no `prose` CSS exists, so the `prose prose-sm` classes in `markdown-content.tsx` are dead — the markdown reader is running on a handful of arbitrary `[&_h1]:text-lg` overrides.
- **Visual overlays:** No browser automation available this session and the dev server was not confirmed running, so no live overlay was injected. Findings are from source review + the CLI detector. Re-run with the dashboard served (`pnpm --filter @librarian/dashboard dev`) and a browser tool for in-page overlays.

## Overall Impression

This is a genuinely well-engineered admin surface — safe (compare-and-swap, confirm dialogs, git-recoverable deletes), honest (teaching copy on every dialog), and information-complete (tree, rendered markdown, wikilinks, backlinks, frontmatter, per-file history with diff + restore). The *engineering* is the strong part.

The *design* is mid-migration and it shows on the one surface where it matters most: the place the operator reads their curated knowledge. The reading pane is a bordered shadcn card with thin, under-built markdown typography; the chrome around it is half on the editorial system, half on legacy tokens. The single biggest opportunity: bring the content surfaces onto the "Reading Room" system and make the markdown pane the typographic hero it should be.

## What's Working

- **Teaching copy is exemplary.** "Wikilinks pointing at the old filename are rewritten across the vault, so nothing dangles." "Removed as a git commit — it stays recoverable." This is the rare admin tool that explains its own safety model inline. Keep every word.
- **Safety model is visible and correct.** Compare-and-swap conflict detection on save, schema validation that renders inline (never writes invalid), live 2KB byte counter for primer/curator files, confirm-behind-dialog for rename/delete/restore. Error prevention is a real strength.
- **Domain IA is right.** Tree → file → (rendered body + Properties + Backlinks) → History/diff/restore mirrors how an Obsidian user already thinks. Frontmatter relabeled "Properties" is a thoughtful real-world match.

## Priority Issues

### [P1] Content surfaces are generic shadcn cards, not the editorial system
- **Why it matters:** This is the precise "escape generic-admin feel" goal from PRODUCT.md, failing on the highest-traffic surface. The markdown article (`rounded-md border bg-card p-6`), `FrontmatterTable`, `BacklinksPane`, the history commit list, and the diff `<pre>` are all stock shadcn cards with `text-muted-foreground`. DESIGN.md's Flat-By-Default and Sharp-Corner rules are violated throughout.
- **Fix:** Migrate to flat hairline surfaces — drop `rounded-md`/`bg-card`/`border`, separate with `Hairline` + `paper-surface` only where a true panel is needed; swap `text-muted-foreground` → `text-foreground/60`; replace the hand-rolled kind badge with the `Pill` component (`accent`/`default`).
- **Suggested command:** `/impeccable polish`

### [P1] The markdown reading pane is typographically dead
- **Why it matters:** Reading memories/handoffs/references is the vault's entire purpose. `prose prose-sm` is a no-op (no `@tailwindcss/typography`, no `prose` CSS), so the body falls back to `[&_h1]:text-lg` (18px) / `[&_h2]:text-base` / `[&_h3]:text-sm` — headings barely larger than body, no Fraunces display, no spacing rhythm, no measure cap, and blockquotes/tables/`hr`/code blocks/ordered+nested lists are unstyled.
- **Fix:** Build a real editorial prose style — Fraunces headings on a proper scale, Newsreader body capped at 65–75ch, styled lists/blockquotes/tables/code, IBM Plex Mono for code. Either install + theme `@tailwindcss/typography` or author a scoped `.vault-prose`.
- **Suggested command:** `/impeccable typeset`

### [P2] Mode switching uses plain buttons; current mode is nearly invisible
- **Why it matters:** view / edit / history is a textbook tab set, but it's three `outline` buttons. Only History exposes `aria-pressed`; there's no active indicator for view vs edit. Visibility-of-status + consistency both suffer, and the `ui-v2` `Tabs` (with the vermilion underline) already exists.
- **Fix:** Replace the button row with `ui-v2` `Tabs` so the active mode reads at a glance and the surface matches the rest of the redesign.
- **Suggested command:** `/impeccable polish`

### [P2] No power-user efficiency on a power-user surface
- **Why it matters:** The operator is `Alex`. There are no keyboard shortcuts (edit/save/history/cancel), no filter/search over the tree (a 500-file vault is an unscannable 260px column), and every file open is a full server navigation. The redesign's keyboard-first promise — `KeyHint`, `j/k` — is entirely absent here.
- **Fix:** Add a tree filter input; `KeyHint`s on Edit/Save/History; `j/k` tree navigation; consider client-side detail swap so selection feels instant. (Tree filter is a net-new feature — better scoped via `shape`.)
- **Suggested command:** `/impeccable harden` (+ `/impeccable shape` for the tree filter)

### [P2] Destructive actions look benign; no feedback on selection
- **Why it matters:** Delete and Restore confirm with `variant="primary"` — the same vermilion as benign Create/Save (`ui-v2` Button has no destructive variant, though `--destructive` exists). And selecting a tree file triggers a full navigation with no pending/skeleton state, so a slow vault read looks frozen.
- **Fix:** Add a destructive button treatment for the confirm step of delete/restore; add a loading indicator on file selection (`loading.tsx` / optimistic selected state).
- **Suggested command:** `/impeccable harden`

## Persona Red Flags

**Alex (Power User):** No keyboard shortcuts for any action. No tree filter/search — a large vault is an unfiltered scroll. Every file open is a full page navigation (no client-side swap). `KeyHint` exists in the system but isn't wired here. Will feel slow and hand-holdy.

**Sam (Accessibility):** `ui-v2` `Button` defines no `focus-visible` ring (relies on the UA outline; inconsistent with `Tabs`/`Dialog`, which do ring). The editorial `Input` focus cue is a border-color change only — a color-only signal that's borderline for low vision. `text-muted-foreground` on `bg-card` (kind badge, labels) needs a 4.5:1 check. Mode state leans on `aria-pressed` alone.

**The Operator / Curator (project persona, from Design Context):** Expects a "considered editorial tool" that practices what it preaches; instead reads their curated knowledge inside a stock shadcn card with thin heading hierarchy. The brand promise ("practice what you preach") is undercut exactly where the operator spends their reading time, and long documents are tiring to scan.

## Minor Observations

- `Last modified {file.mtime}` prints a raw mtime in muted text — humanize it and set it in mono (Mono-for-Machines).
- Diff coloring: green/red add-remove is a fair real-world convention (and the `+`/`-` glyphs remain for color-blind users), but `text-sky-600` on `@@` hunk headers is gratuitously off-palette — use ink/muted.
- The "Activity" audit-trail entry is a tiny `text-sm underline` link — weak affordance for an important surface; promote it.
- New-file and editor `textarea`s use legacy boxed `rounded-md border-input bg-background`; the raw editor is `text-xs` (12px) for writing markdown — cramped, and off the editorial Input vocabulary.
- Tree rows are `px-2 py-1` (~28px) — below the 44px mobile touch target (`Casey`).

## Questions to Consider

- What would the vault feel like if the **reading pane were the hero** — full editorial typography, generous measure — instead of a bordered card sharing weight with the sidebar?
- Could file selection be **instant** (client detail swap / optimistic state) rather than a full server navigation?
- If view / edit / history is a tab set, why is it three buttons?
- For a 500-file vault, how does the operator **find** a file with no filter?

## Addendum — user-reported layout break (post-critique, P0)

Source-only review (no running browser) under-weighted a hard layout failure the
operator confirmed: **the surface is broken on mobile and mostly unusable at 13".**

- **[P0] History/diff column overflow blows the page out.** `DiffView` is a `<pre>`
  with `whitespace-pre` (no wrap) inside a CSS grid track (`lg:grid-cols-[1fr_2fr]`
  in `file-history.tsx`; the content grid `lg:grid-cols-[2fr_1fr]` in `file-view.tsx`
  is the same hazard). Grid/flex children default to `min-width: auto`, so a long
  unwrapped diff line expands the track past the viewport and pushes the Restore
  button (and the rest of the layout) off-screen. Root-cause fix: `min-w-0` on the
  grid children so `overflow-x-auto` scrolls *within* the column. → `/impeccable layout`
- **[P1] History list shouldn't own a whole column.** The commit blocks are long and
  waste a full `1fr`/`2fr` column. Restructure: stack the list above the diff, or make
  each commit an accordion row that loads its diff inline when expanded — removing the
  wide second column entirely and fixing narrow screens at the same time. → `/impeccable layout`
- **[P1] Unusable on mobile / 13".** Beyond the overflow: tree rows below 44px, the
  fixed 260px sidebar, and the nested two-column grids need a real responsive pass
  (stacking, thumb-zone, contained scroll). → `/impeccable adapt`

Decision: fix `/vault` now; the shadcn-card → editorial migration is **flagged as a
cross-surface follow-up** (Memories, Curator, Proposals, etc. likely share it).
