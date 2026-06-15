---
name: The Librarian Dashboard
description: Editorial admin cockpit for a markdown-native agent-memory vault — a quiet reading room with the precision of an instrument.
colors:
  # Manuscript (light) — warm paper room, verdigris rubric.
  paper-body: "#f5f1e8"
  paper-surface: "#faf7f0"
  ink: "#1a1612"
  mono-fill: "#ede7d8"
  verdigris: "#3f9c8e" # the patina of oxidized copper — rubric accent (action / state)
  sage: "#7b8b6f"
  copper: "#b87333" # structural hardware (gilt rules, sidebar markers); NEVER state
  hairline: "#1a16121f"
  # Scriptorium (dark) — candlelit-at-midnight teal canvas, cyan rubric
  # (already in the verdigris family — the shared accent DNA that links
  # the two themes).
  teal-body: "#0e2a36"
  teal-surface: "#163847"
  parchment-ink: "#e8d9b8"
  teal-mono-fill: "#1a3a48"
  cyan: "#7dd3c0"
  muted-teal: "#6b8a7c"
  copper-dark: "#d49872" # polished copper for the cool field
  hairline-dark: "#e8d9b829" # parchment ink @ 16%
  browser-chrome: "#061b22"
typography:
  display:
    fontFamily: "Fraunces, Georgia, serif"
    fontSize: "1.25rem"
    fontWeight: 400
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Fraunces, Georgia, serif"
    fontSize: "1.125rem"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Newsreader, Georgia, serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  data:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "0.6875rem"
    fontWeight: 500
    letterSpacing: "0.08em"
rounded:
  sharp: "0px"
  legacy: "0.5rem"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.sharp}"
    padding: "6px 12px"
    typography: "{typography.body}"
  button-primary:
    backgroundColor: "transparent"
    textColor: "{colors.verdigris}"
    rounded: "{rounded.sharp}"
    padding: "6px 12px"
    typography: "{typography.body}"
  input-underline:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.sharp}"
    padding: "6px 4px"
    typography: "{typography.body}"
  pill-default:
    backgroundColor: "{colors.mono-fill}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sharp}"
    padding: "2px 6px"
    typography: "{typography.label}"
  pill-accent:
    backgroundColor: "transparent"
    textColor: "{colors.verdigris}"
    rounded: "{rounded.sharp}"
    padding: "2px 6px"
  table-cell:
    textColor: "{colors.ink}"
    typography: "{typography.data}"
    height: "32px"
    padding: "0 8px"
  dialog-content:
    backgroundColor: "{colors.paper-surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sharp}"
    padding: "24px"
---

# Design System: The Librarian Dashboard

## 1. Overview

**Creative North Star: "The Reading Room — library materials, digital behaviour."**

A quiet research library *and* a working AI memory vault. The two coexist by
design: the materials in the foreground are tangible craft — paper, ink, copper
hardware, hairlines, the librarian figure herself, a quill in an inkwell — while
the substrate behind them is networked and lit. Nodes and edges hum quietly on
hero surfaces; the one active element on any view *glows*; the librarian holds
an illuminated orb of active memory. The library is what the operator handles;
the AI is what those handles are doing. Neither vocabulary dominates because
neither is decoration.

The body is warm paper (light) or deep teal (dark); the text is ink or warm
parchment. Rules are hairlines drawn at 1px. The chrome recedes so the corpus
is what you see. The mood is the one PRODUCT.md names: *editorial · scholarly
· calm*. But "calm" here is not "soft" — it is the calm of a well-set page or
a precise instrument, never the calm of timidity.

There is one **action accent**: **verdigris** in *Manuscript*, **cyan** in
*Scriptorium* — the rubricator's pen, now a patina-teal rather than verdigris
because old library hardware oxidizes that way and because verdigris and cyan
sit in the same accent family, linking the two themes. Spent only on the
single primary action of a view, the current selection, and the focus ring.

A second, **structural** accent — **copper** — carries hardware: the gilt
margin rule on editorial surfaces, the sidebar nav-item marker, borders on
technical pills. Verdigris is what copper becomes when it oxidizes, so the two
accents tell a single chemical story — bright copper hardware on the catalog
drawers, patina-teal where time has touched it. They coexist because they play
different roles, not because they're "harmonious shades." Both accents earn
their place by being rare; if two things on a screen wear the rubric, one of
them is wrong.

This system explicitly **rejects** the things PRODUCT.md rules out. It is **not**
a default shadcn / Vercel SaaS admin — no rounded cards, no drop shadows, no
slate-gray dark mode. It is **not** AI-slop landing dressing — no cream-bg-by-
reflex, no gradient text, no glassmorphism, no tiny uppercase tracked eyebrows
over every block, no hero-metric cards. It is **not** a cold enterprise console
(density for its own sake, gray and joyless), and it is **not** consumer-playful
(bubbly corners, mascots, emoji, gamification).

**Key Characteristics:**

- Two themes: light *Manuscript* (warm paper + ink, default) and dark *Scriptorium* (deep teal canvas, warm parchment text, paper-warm surfaces — "warm objects in a cool room").
- One rubric accent — **verdigris** (light) / **cyan** (dark) — reserved for the one real action, current selection, and focus ring. Same accent family across themes (verdigris and cyan both sit in the patina-teal range).
- One structural accent — **copper** — for hardware: gilt margin rules, the sidebar nav-item marker, borders on technical pills. Verdigris is its oxidized form; the pairing is chemical, not just chromatic. Never state.
- Flat by default, with **one illuminated element per surface**: soft glow on the focus ring, the active tab underline, the running pending state — never decoration. Drop shadows on cards are still banned.
- Sharp corners (0px radius) on editorial components.
- Three-face editorial type system: Fraunces (display), Newsreader (body), IBM Plex Mono (machine strings).
- Dense, keyboard-first: ⌘K palette, `j/k` navigation, `/` filter, inline `KeyHint` shortcuts.
- Brand graphic primitives — the **librarian mark** (sidebar + empty-state hero), the **constellation backdrop** (low-opacity AI substrate on landing surfaces only), the **memory orb** (loading / consulting) — give the figure real places to stand rather than the failed watermark approach.

## 2. Colors: The Manuscript & Scriptorium Palette

A warm-paper neutral field with a single illuminated accent. Two themes share
every component shape; only the palette swaps.

### Primary — the rubric accent

- **Verdigris** (`#3f9c8e`, light) / **Cyan** (`#7dd3c0`, dark): the rubricator's
  pen. The primary-action button outline and text, the active tab underline, the
  selected-row wash (at ~8% opacity), the focus ring (with bloom — see §4), the
  inline `KeyHint` border, the accent `Pill`, the pulsing nodes in the
  constellation backdrop, the active state on the memory orb. Token:
  `--ink-accent`. **One thing per surface wears this colour.**

  The hue is the patina of oxidized copper — chemically connected to the copper
  structural accent below, deliberately library-aged rather than the alarmist
  verdigris the system used to carry. The same accent family carries through to
  the dark theme's cyan, so the two themes share an accent DNA rather than
  feeling like separate brands.

### Secondary — the state hue

- **Sage** (`#7b8b6f`, light) / **Muted teal** (`#6b8a7c`, dark): desaturated for
  *secondary / paused / muted* state only — e.g. a paused curator, a superseded
  memory. Token: `--ink-accent-subdued`. State colour, never decoration, never
  competes with the rubric accent.

### Structural — the metallic accent

- **Copper** (`#b87333`, light) / **Polished Copper** (`#d49872`, dark): the
  bright form of the same metal that, oxidized, gives the system its verdigris
  rubric. Plays the role of **hardware on a manuscript** — gilt inner rules
  around hero illustrations and editorial article surfaces, the small marker on
  the active sidebar nav item, borders on technical `Pill`s, edges of the
  brand-graphic frames, the constellation backdrop's connective edges. Token:
  `--ink-copper` (full) / `--ink-copper-soft` (~32% alpha for quiet ornament).

  The dark-theme copper is tuned warmer / brighter than the light-theme value
  so it still reads as a polished metal against the deep teal canvas rather
  than getting absorbed into the surrounding cool teals.

  **The Copper-Never-State Rule:** copper is always structural — it never marks
  the active item on its own, never carries hover or focus, never replaces
  verdigris/cyan. Copper + rubric coexist because they play different roles,
  and because verdigris *is* copper at a later stage of oxidation — the
  pairing is elemental, not just chromatic.

### Neutral

- **Ink** (`#1a1612`, light) / **Parchment Ink** (`#e8d9b8`, dark): the single
  foreground. All text, all icons. Lower opacities (`/70`, `/60`, `/40`) step it
  back for secondary text, labels, and placeholders. Token: `--foreground`.
- **Paper — Body** (`#f5f1e8`, light) / **Deep Teal** (`#0e2a36`, dark): the page
  field, behind everything. Token: `--background`. The dark variant is the
  candlelit scriptorium, *not* a dimmed paper room — the field is cool so warm
  surfaces and the librarian figure glow against it.
- **Paper — Surface** (`#faf7f0`, light) / **Surface Teal** (`#163847`, dark):
  raised reading surfaces — dialogs, popovers, the editorial card fill. One step
  lifted from the body. Token: `--ink-surface`.
- **Mono Fill** (`#ede7d8`, light) / **Teal Mono Fill** (`#1a3a48`, dark): the
  fill behind mono chips and id tokens. Token: `--ink-mono-fill`.
- **Hairline** (`#1a1612` @ 12% / `#e8d9b8` @ 16%): the only divider.
  Token: `--ink-hairline`.
- **Browser Chrome** (`#061b22`): a deep petrol used *only* for the mobile
  browser theme-color bar and the PWA tile — never a UI surface. Listed so it
  isn't mistaken for an in-app colour.

### Named Rules

**The One Pen Rule.** The rubric accent (verdigris / cyan) carries the single
primary action of a view and the current selection — nothing else. If two things
on a screen are accented, one of them is wrong. Its rarity is the signal.

**The Warm Paper Rule.** The body is warm paper (`#f5f1e8`), chosen deliberately
for a tool meant for slow, careful work — it is **not** the cream-by-reflex of a
generated landing page. Warmth is carried by paper + ink + the rubric accent, so
do **not** tint every surface "because the brand feels warm." Surfaces step in
tone, not in hue.

## 3. Typography

**Display Font:** Fraunces (with Georgia, serif)
**Body Font:** Newsreader (with Georgia, serif)
**Label / Mono Font:** IBM Plex Mono (with ui-monospace)

> The licensed target faces are **PP Editorial New** (display) and **PP Neue
> Montreal** (text); Fraunces + Newsreader are the free fallback shipping today
> and the swap-in is a one-liner in `app/layout.tsx` once the licence lands.

**Character:** Two serifs and a mono, not a serif-plus-sans. Fraunces is a
high-contrast display serif with optical sizing and a little wonk; Newsreader is
a calm, screen-tuned reading serif. They share a spine but differ in voice
(display vs. text), and IBM Plex Mono supplies the hard contrast axis. The result
reads as a set page, not an app shell — yet every machine string stays
unmistakably mechanical.

### Hierarchy

- **Display** (Fraunces, 400, ~1.25–1.5rem, `-0.01em`, line-height 1.15): page and
  surface titles, the `Inspector` heading (`text-xl`). Fixed rem, never `clamp()`
  — this is product UI, not a hero.
- **Title** (Fraunces, 500, 1.125rem, `tracking-tight`): dialog titles, section
  heads.
- **Body** (Newsreader, 400, 0.875rem, line-height 1.5): prose, descriptions, and
  — distinctively — control labels and button text (`font-sans` resolves to
  Newsreader). Cap reading prose at 65–75ch.
- **Data** (IBM Plex Mono, 400, 0.8125rem): table cells, the dense list surfaces.
- **Label** (IBM Plex Mono, 500, 0.6875rem, `0.08em`, uppercase): table column
  heads (`text-foreground/60`), eyebrow-scale metadata. KeyHint drops to 10px.

### Named Rules

**The Mono-for-Machines Rule.** Every machine-generated string — ids (`mem_…`,
`ses_…`), timestamps, tokens, counts, query chips, raw values in a filter — is
set in IBM Plex Mono. Prose and headings are the serifs. The mono / serif split
is how the eye tells *human* from *machine* at a glance; never set an id in serif
or a sentence in mono.

**The Serif Spine Rule.** This UI does not reach for a neutral sans for "chrome."
Buttons, labels, and inputs are set in Newsreader on purpose; a sans default here
would erase the editorial voice and pull the surface back toward generic admin.

## 4. Elevation & Illumination

**Flat by default — there are no drop shadows on cards, dialogs, or nav.** Depth
is conveyed by a **hairline** (1px at 12% ink) or a **tonal wash** (foreground at
a low alpha). The `Dialog` floats over a `bg-black/50` overlay and a fill of
`paper-surface` with a hairline border — no shadow at all. A "card" is paper
bounded by a hairline, never a lifted slab.

But **the one illuminated element per surface earns a soft glow.** The library
materials stay flat; the *digital substrate* permits a quiet, meaningful glow on
exactly the thing that's currently active — the focus ring, the active tab
underline, the running pending dot, the memory orb mid-pulse. This is what gives
the AI substrate a body without dropping the system into glassmorphism.

### Tonal Layering Vocabulary

- **Inspector / rail fill** (`foreground / 2%`): the right-rail detail panel reads
  as a quieter plane than the content.
- **Row hover** (`foreground / 3%`): the only feedback a table row needs.
- **Chip / pill fill** (`foreground / 6%`, or the `mono-fill` token): a machine
  string sits in a faint wash, not a bordered box.
- **Selected row** (`accent / 8%`): selection is the accent, barely tinted.

### Glow Tokens

- `--glow-accent` — full bloom: `0 0 12px` of the rubric accent at ~35% alpha
  (light) / 14px at 45% (dark, where the cool field swallows weak halos). Used
  on the focus ring, the active tab underline.
- `--glow-accent-subtle` — half bloom, for ambient lit elements like the tree-
  row pending dot or the memory-orb at rest.
- Utility classes `glow-accent` / `glow-accent-subtle` apply them as
  `box-shadow`.

### Named Rules

**The One Illuminated Element Rule.** On any given surface, exactly one element
glows — the same element that wears the rubric accent. If two things glow, one
of them is wrong. The rarity is the signal; over-applied glow becomes the same
SaaS shimmer the system rejects.

**The Flat-Materials Rule.** Library materials (paper, ink, hairline, copper) are
always flat. The glow is on the *digital* element (focus state, pending, active
selection) — never on a card or a panel. Lift a card and you've shipped a
shadcn / Stripe admin.

**The No-Glass Rule.** Soft glow ≠ glassmorphism. No backdrop-filter blur, no
translucent overlays as decoration, no "frosted" anything. Glow is a box-shadow
or a filter on a single element; glass is a layered surface. They are different.

## 5. Brand Graphics

The library figure and her constellation are real graphic elements in the
layout, not decorative watermarks. After two failed attempts (a 32px top-left
logo too small to read, and a faint background watermark obscured by every UI
element on top), the brand vocabulary now has three components that give the
figure earned, legible places to appear.

### LibrarianMark

The librarian figure (profile, robe, halo, the memory orb in her hand) lifted
from the brand banners as two SVG files (`/brand/librarian-mark-light.svg` and
`-teal.svg`). The component picks the correct file by `useTheme()`. Sizes:

- **`sidebar`** (38×56 px) — beside the page heading on the vault, the future
  Memories cockpit, and other major surface sidebars. Legible at glance; the
  orb still reads as the active mark.
- **`hero`** (220×320 px) — empty-state anchors (`/vault` before a file is
  picked, `/memories` first run, etc.). Centred above the copy.
- **`loading`** (22×32 px) — reserved for future loading composites; the bare
  `MemoryOrb` covers most loading moments more economically.

### ConstellationBackdrop

A thin, low-opacity SVG pattern — nodes and edges in the copper-soft tone with
two rubric nodes that pulse on a 6-second stagger when `live`. The pattern
tiles a hand-tuned 280×280 cell so it reads composed rather than uniform-grid.
Used **only on landing / empty / hero surfaces** — never on dense data. Honours
`prefers-reduced-motion` (static glow, no pulse). The constellation is the AI
substrate made visible.

### MemoryOrb

The illuminated dot in the librarian's hand, extracted as a primitive. A solid
rubric-accent circle with a scale-matched drop-shadow bloom; opt-in `pulse`
prop runs a 1.8 s breathing cycle (reduced-motion: static, lit). Used for:

- **Loading / consulting** state (replaces spinners; "consulting memory" reads
  truer than "please wait").
- **Active running indicators** (paired with the tree-link pending dot, etc.).
- Hero loading composites alongside the figure.

### EmptyState

The composed surface: hairline frame + copper gilt inner rule (the manuscript
margin) + animated constellation backdrop + hero-scale `LibrarianMark` + a
serif heading and editorial copy + optional action row. Caller supplies title,
body, optional action; layout, framing, motion, and density are the system's
job. This is what every empty / landing / first-run surface should look like
when it doesn't have a record to show.

### Named Rules

**The Earned-Scale Rule.** The librarian figure appears where there is space
for her to be legible: the sidebar mark, an empty-state hero, a loading
composite. She does **not** appear on dense data surfaces (tables, settings
forms in flow) where she'd be decoration crowding the task. The watermark
approach failed because every appearance was either too small to read or too
faint to register — the answer is fewer appearances at legible scale, not more
appearances at smaller scale.

**The Substrate-on-Hero-Only Rule.** The constellation backdrop appears only
on landing, empty, and hero surfaces. Dense data surfaces (tables, configured
settings, the file editor) stay free of the pattern; the AI substrate is
visible where you have time to look at it, invisible where you need to work.

## 6. Components

Every editorial component shares a vocabulary: sharp corners, hairline edges, ink
on paper, and the rubric accent held in reserve. They live under
`components/ui-v2/` and are drop-in replacements for the legacy shadcn set during
the rolling D1.x migration.

### Buttons

- **Shape:** square (`0px` radius). No drop shadow.
- **Outline (default):** transparent fill, 1px `foreground/20` border, ink text;
  hover lifts a `foreground/4%` wash. The everyday action.
- **Primary:** transparent fill, 1px **verdigris** border and verdigris text;
  hover `verdigris/6%`. Exactly one per surface — the One Pen Rule applied to
  action.
- **Ghost:** transparent border, ink text, `foreground/4%` hover. For toolbar /
  inline actions.
- **Padding:** `6px 12px`; `text-sm`; `disabled:opacity-50`.

### Chips & Pills

- **Pill — default:** mono text in a faint fill (`mono-fill`), square corners,
  `2px 6px`. For ids, timestamps, event types. *(The current stub uses a
  `foreground/6%` wash pending wiring to the `mono-fill` token.)*
- **Pill — accent:** verdigris text + verdigris hairline border, sans. The one
  state per view that matters.
- **Pill — muted:** sage text + sage border. Secondary / paused state.
- **FilterChip:** a `label` (sans, `foreground/70`) + `value` (mono, ink) in a
  `foreground/3%` box with a `foreground/15` border and a `×` remove handle that
  reddens to verdigris on hover.

### Inputs / Fields

- **Style:** no box. A single hairline **bottom** border (`--ink-hairline`),
  transparent fill, ink text, `text-sm`. A `mono` variant sets technical input in
  IBM Plex Mono.
- **Focus:** the bottom border becomes **verdigris** (`focus:border-ink-accent`);
  no ring, no glow. Crisp, instrument-like.
- **Placeholder:** `foreground/40` — verify this clears 4.5:1 on paper; bump toward
  ink if it doesn't.

### Tables

- **The signature surface.** No card chrome. 32px rows, `13px` mono/sans body,
  `11px` uppercase mono column heads at `foreground/60`.
- **Separators:** a hairline under the header and under every row — no vertical
  rules, no zebra.
- **States:** row hover `foreground/3%`; selected row `verdigris/8%` via
  `data-state="selected"`.

### Navigation

- **Top bar only.** A persistent strip with a hairline bottom edge over a
  `bg-muted/20` field; the monochrome line-art mark at left, tab links, then
  version badge / theme toggle / sign-out at right. Active tab: `bg-background` +
  `text-foreground`; inactive: `foreground/60` → `foreground` on hover. Collapses
  behind a hamburger below `md`.
- **Tabs (in-page):** Radix tabs with a hairline strip; the active trigger carries
  a 2px **verdigris** underline (`border-b-2`) and ink text; focus shows a 2px
  verdigris ring.

### Dialog

Radix dialog, editorial chrome: `paper-surface` fill, 1px hairline border, **no
shadow**, `24px` padding, a Fraunces (`font-display`) title, and a hairline-ruled
header and footer. Overlay is `black/50` with a plain fade — no scale, no blur.

### Inspector (signature)

The right-rail detail panel every list surface drops selected-row content into: a
hairline left border, a `foreground/2%` fill, a Fraunces `text-xl` title, and a
scrollable ink body. Collapse + the `[` shortcut are part of its contract.

### KeyHint (signature)

A small `kbd` set in IBM Plex Mono `10px` uppercase with a `verdigris/40` border
and verdigris text, rendered inline beside an action so the operator learns the
shortcut without opening the cheatsheet. The literal expression of keyboard-first
stewardship.

### Named Rules

**The Sharp Corner Rule.** Editorial components have a `0px` radius. A rounded
card is the single fastest way to make this surface read as default shadcn — so
corners are square unless a Radix primitive ships otherwise.

## 7. Do's and Don'ts

### Do:

- **Do** reserve the rubric accent (verdigris `#3f9c8e` / cyan `#7dd3c0`) for
  the one primary action and the current selection — the One Pen Rule.
- **Do** set every machine string (ids, timestamps, tokens, counts) in IBM Plex
  Mono, and all prose / labels in the serifs.
- **Do** separate with a hairline (`--ink-hairline`, 1px @ 12%) or a tonal wash
  (`foreground/2–6%`). Depth is tone, never shadow.
- **Do** keep corners square (`rounded-none`) on editorial components.
- **Do** step surfaces in **tone** (paper-body → paper-surface → mono-fill), not
  in hue.
- **Do** verify contrast: body ≥4.5:1, large ≥3:1, and check muted/placeholder
  ink on warm paper — it's the easy WCAG 2.1 AA miss here.
- **Do** give every control a visible focus state (the verdigris border / `ring-2
  ring-ink-accent`) and a keyboard path; pair primary actions with a `KeyHint`.

### Don't:

- **Don't** ship the default shadcn / Vercel SaaS admin look — no rounded cards,
  no drop shadows, no slate-gray dark mode.
- **Don't** use AI-slop landing dressing: no cream-bg-by-reflex, no gradient text
  (`background-clip: text`), no glassmorphism, no tiny uppercase tracked eyebrows
  over every section, no hero-metric cards.
- **Don't** drift toward a cold enterprise console (gray, joyless, dense for its
  own sake) or toward consumer-playful (bubbly corners, mascots, emoji,
  gamification).
- **Don't** write `box-shadow`. If a surface needs to lift, it doesn't — give it a
  hairline.
- **Don't** introduce a second accent hue or a neutral sans for chrome. Two serifs
  + one mono + one rubric accent is the whole system.
- **Don't** accent two things on one screen. If everything is illuminated, nothing
  is.
