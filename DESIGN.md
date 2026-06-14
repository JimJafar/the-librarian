---
name: The Librarian Dashboard
description: Editorial admin cockpit for a markdown-native agent-memory vault — a quiet reading room with the precision of an instrument.
colors:
  paper-body: "#f5f1e8"
  paper-surface: "#faf7f0"
  ink: "#1a1612"
  mono-fill: "#ede7d8"
  vermilion: "#d14b2a"
  sage: "#7b8b6f"
  hairline: "#1a16121f"
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
    textColor: "{colors.vermilion}"
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
    textColor: "{colors.vermilion}"
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

**Creative North Star: "The Reading Room"**

A quiet research library, rendered with the exactness of a technical instrument.
The body is warm paper, the text is ink, and rules are hairlines drawn at 1px —
the chrome recedes so the corpus is what you see. The mood is the one PRODUCT.md
names: *editorial · scholarly · calm*. But "calm" here is not "soft": the surface
is crisp and precise, mono-forward for every machine-generated string, closer to
a well-set reference work or an instrument panel than to anything hand-made or
decorative. The operator is a steward curating a living knowledge graph; the
interface behaves like good library furniture — it disappears into the task.

There is exactly one mark of colour, and it is the rubricator's pen: **vermilion**
in the light *Manuscript* theme, **saffron** in the dark *Scriptorium* theme.
It is spent only on the single primary action of a view and on the current
selection. Everywhere else the system works in paper, ink, and hairline. Depth is
never a drop shadow — it is a tonal shift or a 1px rule.

This system explicitly **rejects** the things PRODUCT.md rules out. It is **not**
a default shadcn / Vercel SaaS admin — no rounded cards, no drop shadows, no
slate-gray dark mode. It is **not** AI-slop landing dressing — no cream-bg-by-
reflex, no gradient text, no glassmorphism, no tiny uppercase tracked eyebrows
over every block, no hero-metric cards. It is **not** a cold enterprise console
(density for its own sake, gray and joyless), and it is **not** consumer-playful
(bubbly corners, mascots, emoji, gamification).

**Key Characteristics:**

- Warm paper + ink, two themes (light *Manuscript* default, dark *Scriptorium*).
- A single rubric accent — vermilion / saffron — reserved for the one real action and current state.
- Flat by default: no shadows, ever. Separation is a hairline or a tonal wash.
- Sharp corners (0px radius) on editorial components.
- A three-face editorial type system: Fraunces (display), Newsreader (body), IBM Plex Mono (machine strings).
- Dense, keyboard-first: ⌘K palette, `j/k` navigation, inline `KeyHint` shortcuts.

## 2. Colors: The Manuscript & Scriptorium Palette

A warm-paper neutral field with a single illuminated accent. Two themes share
every component shape; only the palette swaps.

### Primary

- **Vermilion** (`#d14b2a`, light) / **Saffron** (`#e6a33d`, dark): the rubricator's
  pen. The primary-action button outline and text, the active tab underline, the
  selected-row wash (at ~8% opacity), the focus ring, the inline `KeyHint` border,
  the accent `Pill`. Token: `--ink-accent`. This is the only hue in the system.

### Secondary

- **Sage** (`#7b8b6f`, light) / **Sage** (`#7a8b5c`, dark): a desaturated green-gray
  for *secondary / paused / muted* state only — e.g. a paused curator, a
  superseded memory. Token: `--ink-accent-subdued`. It is a state colour, never
  decoration, and never competes with the rubric accent.

### Neutral

- **Ink** (`#1a1612`, light) / **Parchment Ink** (`#e8e0d0`, dark): the single
  foreground. All text, all icons. Lower opacities (`/70`, `/60`, `/40`) step it
  back for secondary text, labels, and placeholders. Token: `--foreground`.
- **Paper — Body** (`#f5f1e8`, light) / **#1c1814** (dark): the page field, behind
  everything. Token: `--background`.
- **Paper — Surface** (`#faf7f0`, light) / **#231e18** (dark): raised reading
  surfaces — dialogs, popovers, the editorial card fill. One step warmer/lighter
  than the body. Token: `--ink-surface`.
- **Mono Fill** (`#ede7d8`, light) / **#2a241d** (dark): the fill behind mono
  chips and id tokens. Token: `--ink-mono-fill`.
- **Hairline** (`#1a1612` at 12%, light) / **#e8e0d0** at 14% (dark): the only
  divider. Token: `--ink-hairline`.
- **Browser Chrome** (`#061b22`): a deep petrol used *only* for the mobile
  browser theme-color bar and the PWA tile — never a UI surface. Listed so it
  isn't mistaken for an in-app colour.

### Named Rules

**The One Pen Rule.** The rubric accent (vermilion / saffron) carries the single
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

## 4. Elevation

**Flat by default — there are no shadows in this system.** Not on cards, not on
dialogs, not on the nav. Depth is conveyed two ways only: a **hairline** (1px at
12% ink) or a **tonal wash** (foreground at a low alpha). The `Dialog` floats over
a `bg-black/50` overlay and a fill of `paper-surface` with a hairline border — and
no shadow at all. If you find yourself writing `box-shadow`, you have left the
system.

### Tonal Layering Vocabulary

- **Inspector / rail fill** (`foreground / 2%`): the right-rail detail panel reads
  as a quieter plane than the content.
- **Row hover** (`foreground / 3%`): the only feedback a table row needs.
- **Chip / pill fill** (`foreground / 6%`, or the `mono-fill` token): a machine
  string sits in a faint wash, not a bordered box.
- **Selected row** (`vermilion / 8%`): selection is the accent, barely tinted.

### Named Rules

**The Flat-By-Default Rule.** Surfaces are flat at rest and flat in motion.
Separation is a hairline or a tonal step — never a shadow, never a glow, never a
blur. A "card" in this system is paper bounded by a hairline, not a lifted slab.

## 5. Components

Every editorial component shares a vocabulary: sharp corners, hairline edges, ink
on paper, and the rubric accent held in reserve. They live under
`components/ui-v2/` and are drop-in replacements for the legacy shadcn set during
the rolling D1.x migration.

### Buttons

- **Shape:** square (`0px` radius). No drop shadow.
- **Outline (default):** transparent fill, 1px `foreground/20` border, ink text;
  hover lifts a `foreground/4%` wash. The everyday action.
- **Primary:** transparent fill, 1px **vermilion** border and vermilion text;
  hover `vermilion/6%`. Exactly one per surface — the One Pen Rule applied to
  action.
- **Ghost:** transparent border, ink text, `foreground/4%` hover. For toolbar /
  inline actions.
- **Padding:** `6px 12px`; `text-sm`; `disabled:opacity-50`.

### Chips & Pills

- **Pill — default:** mono text in a faint fill (`mono-fill`), square corners,
  `2px 6px`. For ids, timestamps, event types. *(The current stub uses a
  `foreground/6%` wash pending wiring to the `mono-fill` token.)*
- **Pill — accent:** vermilion text + vermilion hairline border, sans. The one
  state per view that matters.
- **Pill — muted:** sage text + sage border. Secondary / paused state.
- **FilterChip:** a `label` (sans, `foreground/70`) + `value` (mono, ink) in a
  `foreground/3%` box with a `foreground/15` border and a `×` remove handle that
  reddens to vermilion on hover.

### Inputs / Fields

- **Style:** no box. A single hairline **bottom** border (`--ink-hairline`),
  transparent fill, ink text, `text-sm`. A `mono` variant sets technical input in
  IBM Plex Mono.
- **Focus:** the bottom border becomes **vermilion** (`focus:border-ink-accent`);
  no ring, no glow. Crisp, instrument-like.
- **Placeholder:** `foreground/40` — verify this clears 4.5:1 on paper; bump toward
  ink if it doesn't.

### Tables

- **The signature surface.** No card chrome. 32px rows, `13px` mono/sans body,
  `11px` uppercase mono column heads at `foreground/60`.
- **Separators:** a hairline under the header and under every row — no vertical
  rules, no zebra.
- **States:** row hover `foreground/3%`; selected row `vermilion/8%` via
  `data-state="selected"`.

### Navigation

- **Top bar only.** A persistent strip with a hairline bottom edge over a
  `bg-muted/20` field; the monochrome line-art mark at left, tab links, then
  version badge / theme toggle / sign-out at right. Active tab: `bg-background` +
  `text-foreground`; inactive: `foreground/60` → `foreground` on hover. Collapses
  behind a hamburger below `md`.
- **Tabs (in-page):** Radix tabs with a hairline strip; the active trigger carries
  a 2px **vermilion** underline (`border-b-2`) and ink text; focus shows a 2px
  vermilion ring.

### Dialog

Radix dialog, editorial chrome: `paper-surface` fill, 1px hairline border, **no
shadow**, `24px` padding, a Fraunces (`font-display`) title, and a hairline-ruled
header and footer. Overlay is `black/50` with a plain fade — no scale, no blur.

### Inspector (signature)

The right-rail detail panel every list surface drops selected-row content into: a
hairline left border, a `foreground/2%` fill, a Fraunces `text-xl` title, and a
scrollable ink body. Collapse + the `[` shortcut are part of its contract.

### KeyHint (signature)

A small `kbd` set in IBM Plex Mono `10px` uppercase with a `vermilion/40` border
and vermilion text, rendered inline beside an action so the operator learns the
shortcut without opening the cheatsheet. The literal expression of keyboard-first
stewardship.

### Named Rules

**The Sharp Corner Rule.** Editorial components have a `0px` radius. A rounded
card is the single fastest way to make this surface read as default shadcn — so
corners are square unless a Radix primitive ships otherwise.

## 6. Do's and Don'ts

### Do:

- **Do** reserve the rubric accent (vermilion `#d14b2a` / saffron `#e6a33d`) for
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
- **Do** give every control a visible focus state (the vermilion border / `ring-2
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
