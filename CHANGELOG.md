# Changelog

All notable changes to **The Librarian** are documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This changelog starts at v0.1.0 — the first version likely to see public
adoption. The pre-v0.1.0 development history lives in the git log; only
changes from this point forward are catalogued here.

## [Unreleased]

### Added

- `AGENTS.md` with the family-wide house rules (privacy, fail-soft,
  cross-repo contracts, etc.) and the main-repo build / test / gotcha
  notes. Sibling AGENTS.md files in the four standalone plugin repos
  share the same baseline so an agent dropped into any repo of the
  family behaves consistently.

### Removed

- `integrations/codex/` and `integrations/pi/` — both harnesses now
  ship as standalone, installable plugins
  ([`the-librarian-codex-plugin`](https://github.com/JimJafar/the-librarian-codex-plugin),
  [`the-librarian-pi-extension`](https://github.com/JimJafar/the-librarian-pi-extension)),
  so the in-tree copyable packages were retired to keep one source of
  truth per harness.
- `@librarian/lifecycle`'s Codex adapter (`src/harness/codex.ts`,
  `src/bin/codex-hook.ts`, the `librarian-codex-hook` bin entry, and
  the `harness-codex.test.ts` suite) — orphaned by the
  `integrations/codex/` removal. The standalone Codex plugin bundles
  its own hook from the Claude plugin's pattern and doesn't depend on
  this package.
- `integrations/opencode/` — opencode has graduated to a standalone
  plugin too ([`the-librarian-opencode-plugin`](https://github.com/JimJafar/the-librarian-opencode-plugin)).
  All five harnesses now ship as standalone repos; no in-tree harness
  packages remain.
- The `integration-wrappers` CI matrix job in
  `.github/workflows/ci.yml` (was opencode-only after the codex+pi
  graduation; now empty → deleted entirely).
- **`integrations/` directory deleted entirely.** With opencode shipping
  as a standalone plugin, every in-tree harness package has graduated;
  the `@librarian/lifecycle` workspace package was orphaned (zero
  consumers outside its own package.json) and removed alongside the
  per-harness packages. The privacy detector source that lived in
  `integrations/shared/librarian-lifecycle/src/privacy.ts` was already
  byte-identically ported into all four plugin repos; the opencode
  plugin's `src/privacy-detector.ts` becomes the de facto canonical TS
  going forward (the four ports are now peers — coordinate any change
  across all four).
- `integrations/shared/*` entry removed from `pnpm-workspace.yaml`.
- `test/integrations.test.ts` renamed to `test/repo-structure.test.ts`
  with reduced scope: dropped the integrations/README.md link check;
  retained the `.claude/commands` per-verb check; added a regression
  test asserting `integrations/` doesn't exist.

## [0.1.0] — 2026-05-26

Public baseline. The Librarian is a portable memory + session layer for AI
agents: one disciplined funnel for recalling, proposing, saving, updating,
and reviewing durable context, plus a neutral cross-harness
session-continuity layer so work started in one harness (Claude Code,
Codex, Hermes, OpenCode, Pi) can be handed off and resumed cleanly in
another.

### Shipped in this baseline

- **Durable memory** — `recall` / `remember` / `verify` over a three-state
  (`active` / `proposed` / `archived`) model, with categories, `common` vs
  `agent_private` scoping, and a proposal flow for protected categories
  (`identity`, `relationship`).
- **Cross-harness sessions** — `start` / `checkpoint` / `pause` / `end` /
  `continue` over a three-state (`active` / `paused` / `ended`) model, with
  a handover package any harness can resume. Session history is evidence;
  durable facts are promoted explicitly.
- **MCP server** — HTTP transport, bearer-token auth, the full tool surface
  including the admin-only verbs surfaced when authenticated with an admin
  token.
- **Memory curator** — an optional scheduled LLM pass that grooms memory
  (dedupe, archive stale, refine), configured and observed from the
  dashboard.
- **Dashboard** — a Next.js admin cockpit (Memories, Sessions, Recall,
  Proposals, Archive, Logs, Analytics, and the Curator cockpit) with a
  persistent nav and ⌘K command palette.
- **Storage** — event-sourced and dependency-light: append-only JSONL
  ledgers + a generated SQLite/FTS5 index on `node:sqlite`. No external
  database required.
- **Harness integrations** — two standalone, installable plugins (Claude
  Code, Hermes) plus copyable setup packages under `integrations/` for the
  rest. See [Harness integrations](./README.md#harness-integrations).

[Unreleased]: https://github.com/JimJafar/the-librarian/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/JimJafar/the-librarian/releases/tag/v0.1.0
