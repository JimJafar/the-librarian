# CLAUDE.md

The canonical agent instructions for this repo live in **AGENTS.md** — the
single source of truth shared by every harness plugin (Claude Code, Codex,
Hermes, Pi). Read and follow them on every change. They're imported below so
this file stays the Claude Code entrypoint without duplicating the rules.

@AGENTS.md

## Design Context

The dashboard redesign (`apps/dashboard`) has a documented design system, set up
with the Impeccable skill. Read these before touching any user-facing component:

- **[PRODUCT.md](./PRODUCT.md)** — strategic: register (`product`), users,
  purpose, brand personality (*editorial · scholarly · calm*), anti-references,
  design principles, accessibility (WCAG 2.1 AA + full keyboard).
- **[DESIGN.md](./DESIGN.md)** — visual: the *"Reading Room"* editorial system —
  warm-paper/ink palette, single vermilion/saffron rubric accent, flat-by-default
  (no shadows), sharp corners, Fraunces / Newsreader / IBM Plex Mono. Tokens in
  the frontmatter are normative.

Run `/impeccable critique`, `/impeccable polish`, or `/impeccable live` against a
surface to iterate on it on-brand.
