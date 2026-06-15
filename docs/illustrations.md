# Illustrations backlog

Working list of where the dashboard redesign will need real
illustrations — places the librarian, a composed scene, or a
hand-drawn graphic would carry the Reading Room aesthetic
better than a system primitive can.

The librarian **mark** (small portrait SVG), the **constellation
backdrop** (programmatic SVG pattern), and the **memory orb**
(primitive) all already exist as system components — they cover
the workaday cases. This file is for the moments where a richer
illustrated treatment is genuinely warranted.

When you obtain an asset:

1. Drop the file in `apps/dashboard/public/brand/` (vector marks)
   or `apps/dashboard/public/illustrations/<surface>/` (scenes).
2. Wire it into the component that needs it.
3. Mark the row **Status: shipped** + add the file path.

Anything tagged **Status: open** is still needed.

## Conventions

- **Themes**: which themes the asset must support — `light`, `dark`,
  or `both`. "Both" means we either ship two variants (preferred) or
  one composition that reads on both fields.
- **Format**: `SVG` strongly preferred for marks, line art, and the
  constellation; `PNG` is fine for painted / composed scenes (e.g.
  the existing reference banners).
- **Dimensions**: minimum render size at 1×. We'll scale and crop as
  needed; bigger is fine.
- **Aspect**: `portrait` / `landscape` / `square` — to match
  placement.

## Existing assets

| Asset | Themes | Format | Dimensions | Used where |
|---|---|---|---|---|
| Librarian mark — light variant | light | SVG | viewBox 767×1116 (~0.687 portrait) | `LibrarianMark` (rail / sidebar / hero / loading sizes) |
| Librarian mark — teal variant | dark | SVG | viewBox 767×1116 (~0.687 portrait) | `LibrarianMark` (rail / sidebar / hero / loading sizes) |
| Reference banners (light + teal) | both | PNG | ~1728×972 landscape | Reference only — not loaded in the code |

## Needed

### Login / chrome-free surfaces

- **Login backdrop** — Status: **open**
  - Surface: `/login` (and `/settings/auth/reset`)
  - Themes: both
  - Format: PNG (composed scene)
  - Dimensions: ~1920×1080 (or larger), landscape; will be
    `object-cover` / cropped to fit
  - Role: hero behind the auth form on the chrome-free routes —
    the moment that sets brand tone before the operator sees the
    dashboard proper. The existing reference banners are very
    close to the right shape; could ship them directly.
  - Notes: the form should be readable at every breakpoint, so
    the scene needs a quieter zone in roughly the centre-left or
    centre-right where the form lands.

### Empty / first-run states

`EmptyState` currently composes the hero `LibrarianMark` + the
animated constellation + serif copy. That's the generic default.
A per-surface illustration is **optional** — only worth
commissioning where a surface-specific scene tells a clearer
story than the generic figure.

- **Memories empty / first-run** — Status: **open** (optional)
  - Surface: `/` when no memories exist yet
  - Themes: both
  - Format: SVG preferred (PNG OK)
  - Dimensions: ≥220×320 portrait, or ≥640×360 landscape
  - Role: replaces the hero `LibrarianMark` inside `EmptyState`
  - Scene: the librarian filing a card into the catalog (the
    moment a memory is first saved)
- **Handoffs empty** — Status: **open** (optional)
  - Surface: `/handoffs` when nothing has been stored
  - Themes: both
  - Format: SVG / PNG
  - Dimensions: ≥220×320 portrait
  - Scene: the librarian handing a sealed letter to a courier
    (the handoff metaphor made literal)
- **Proposals empty** — Status: **open** (optional)
  - Surface: `/proposals` when the curator hasn't proposed
    anything
  - Themes: both
  - Format: SVG / PNG
  - Dimensions: ≥220×320 portrait
  - Scene: the librarian sitting at her desk, ledger closed —
    quietly waiting

### Onboarding / first-run

- **Welcome surface** — Status: **open**
  - Surface: first-time dashboard load after auth setup
  - Themes: both
  - Format: PNG (composed) or SVG (line-art)
  - Dimensions: ~1200×600 landscape hero
  - Role: greets the operator on first sign-in, orients them to
    the metaphor (you're the steward, this is the catalog, the
    librarian is the curator working alongside you)
- **Setup-complete celebration** — Status: **open** (optional)
  - Surface: post-setup confirmation
  - Format: SVG / PNG
  - Dimensions: ~600×400 landscape

### System states

- **Not-found (404)** — Status: **open** (optional)
  - Surface: the global `not-found.tsx`
  - Themes: both
  - Format: SVG / PNG
  - Dimensions: ~600×400 landscape
  - Scene: the librarian peering into an empty drawer, candle
    illuminating dust
- **Server unreachable / maintenance** — Status: **open**
  (optional)
  - Surface: dashboard global error state when the Librarian
    server is offline
  - Themes: both
  - Format: SVG / PNG
  - Dimensions: ~600×400 landscape

### Deferred / nice-to-haves

- **Constellation backdrop — hand-illustrated variant** — the
  current pattern is programmatic SVG (9 composed nodes + edges
  + 2 pulsing rubric nodes). A hand-drawn alternative could be
  richer for hero surfaces; not urgent.
- **Loading composite (large)** — the `MemoryOrb` primitive
  already covers loading at every size. A richer hero-loading
  treatment (librarian silhouette + orb mid-pulse) would only
  matter on operations that genuinely take seconds.
- **Activity timeline anchor** — `/vault/activity` is
  deliberately spartan today; if it grows a richer treatment a
  small recurring illustration at the top could help, but only
  if it earns its scale.

## Out of scope

The system explicitly does **not** want:

- Decorative illustrations on dense data surfaces (Memories
  table, Settings forms, Tokens list, etc.) — those stay text-
  and-mono dense; the librarian's presence there is the
  watermark *only* if a watermark ever comes back, or nothing.
- Icon-style illustrations next to every nav item / metric. The
  one-rubric / one-illuminated-element rules apply: one
  meaningful figure per surface, never decoration.
- Photographs. The brand is editorial / illustrated. A photo
  here would read as a marketing-site bolt-on.

## Process notes

- When a new surface is identified that genuinely needs an
  illustration, **add it here first** with theme + dimensions
  before requesting the asset. Helps Jim know exactly what to
  generate / commission.
- Prefer one well-fitting hero illustration over many small
  spot illustrations. Hero scale earns its place; spot
  decoration is the AI-slop reflex.
