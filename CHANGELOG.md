# Changelog

All notable changes to **The Librarian** are documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This changelog starts at v0.1.0 — the first version likely to see public
adoption. The pre-v0.1.0 development history lives in the git log; only
changes from this point forward are catalogued here.

## [Unreleased]

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
