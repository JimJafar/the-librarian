# Product

## Register

product

## Users

The **operator** who self-hosts The Librarian — typically a single, technical
owner running the server for themselves and their AI agents. In the dashboard
they are a **curator/steward**, not a passive viewer: they review what the
resident curator proposed, accept or reject proposals, flag wrong or stale
memories, edit vault files and the primer, manage handoffs, tokens, backups,
and auth, and tune the curator's prompt addendums.

Their context is **deliberate curation, not high-frequency monitoring.** They
drop in to make considered decisions about a living knowledge graph that agents
read from and write to — then leave. The dashboard is the *complete* admin
surface (rethink: "operators never need git or Obsidian"), so trust and
legibility matter more than dashboards-of-dashboards realtime telemetry.

**Job to be done:** keep the agent-memory corpus accurate, well-organised, and
trustworthy — approve/reject the curator's work, correct mistakes, and
configure the system — without ever dropping to git, a database, or Obsidian.

## Product Purpose

The Librarian is a markdown-native, git-backed knowledge graph — a durable,
portable **memory + handoff layer** for AI agents — served to any harness over
MCP and tended by a resident "curator." The dashboard (Next.js, port 3000) is
its admin cockpit: Memories, Proposals, Flagged, Archive, Handoffs, Analytics,
the Curator cockpit, the Vault explorer/editor, Backups, Tokens, and Settings.

It exists because agents need memory that is durable and human-auditable, and
humans need a surface they can *trust* to oversee and steward that memory.
**Success looks like:** the operator trusts the corpus, can curate it
confidently in a few minutes, never needs to touch git or Obsidian, and feels
like they are working inside a considered editorial tool — not a generic admin
panel bolted onto a database.

## Brand Personality

**Editorial · scholarly · calm.**

Voice: precise, literate, unhurried, craft-respecting. The product's governing
metaphor is a **manuscript vault tended by a resident librarian** — paper, ink,
hairlines, marginalia, a quiet reading room rather than a control panel. The
two shipped themes name this directly: light **Manuscript** (warm paper, the
default — it reads as a tool for slow, deliberate work) and dark
**Scriptorium**.

Emotional goal: **trust and quiet confidence.** The operator should feel like a
careful steward of something valuable, never a button-masher in a noisy
console. Restraint signals competence.

## Anti-references

This should explicitly NOT look like:

- **Default shadcn / Vercel SaaS admin** — rounded cards, drop shadows,
  slate-gray dark mode, the AI/template "starter dashboard" look. This is the
  generic-admin feel the redesign exists to escape.
- **AI-slop landing tropes** — cream-bg-by-default, gradient text,
  glassmorphism, tiny uppercase tracked eyebrows above every section,
  hero-metric cards.
- **Cold enterprise console** — Datadog/Grafana density-for-its-own-sake; gray,
  joyless, a dashboard of dashboards.
- **Consumer-playful** — bubbly rounded corners, mascots, emoji, gamification.
  Too cute for a serious curation tool.

## Design Principles

1. **Earned familiarity, distinctive voice.** Standard affordances behave
   exactly as a fluent user expects — tables, command palette, forms, modals.
   The editorial identity lives in the *material* (paper, ink, hairlines, sharp
   corners, serif headings, mono for technical strings), never in reinventing
   controls. Escape "generic admin" through character, not novelty.
2. **The tool disappears into the task.** Curation is the point; the chrome
   should recede. Density and clarity over decoration — every element earns its
   place by serving a curatorial decision.
3. **Practice what you preach.** This is the admin surface for a meticulously
   curated knowledge system. The UI itself must feel curated, consistent, and
   trustworthy; sloppiness here quietly undermines the product's entire claim.
4. **Keyboard-first stewardship.** The operator does repeated review work — the
   ⌘K palette, `j/k` navigation, per-surface shortcut map, and `?` overlay are
   first-class, not afterthoughts.
5. **Calm, not loud.** No urgency theatre, no gratuitous motion. The accent
   (terracotta in light, ochre in dark) is reserved for the one real action and
   current selection/state — never decoration.

## Accessibility & Inclusion

- **WCAG 2.1 AA.** Body text ≥4.5:1, large text ≥3:1, visible focus rings,
  every control labelled. The warm-paper-with-muted-ink palette is exactly the
  combination that fails contrast by accident — verify it, don't assume it.
- **Full keyboard operation.** Everything reachable without a mouse: the ⌘K
  command palette, `j/k` row navigation, the per-surface shortcut map, and the
  `?` shortcuts overlay. Visible focus state on every interactive element.
- **Reduced motion is baseline.** Motion conveys state, not decoration; every
  animation ships a `prefers-reduced-motion` alternative (crossfade or instant).
- **Two themes, parity in both.** Light **Manuscript** (default) and dark
  **Scriptorium** via `next-themes`; contrast and state vocabulary must hold in
  each.
