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

- **Classifier cutover (Section 4d.1 of the rollout-completion plan, halt-gated).**
  The classifier worker is now wired into `mcp-server`'s HTTP boot
  behind `LIBRARIAN_CLASSIFIER_ENABLED=true`. When the flag is set
  along with the provider-specific env (remote: endpoint + token +
  model; local: model id + optional quant), the worker starts at
  listen time and `remember` lands every new memory at conservative
  defaults (`is_global=false, requires_approval=true,
  status=proposed, classified=0`) — the worker then decides the
  two booleans asynchronously and emits `memory.classified`. When
  its verdict says `requires_approval=false`, the worker promotes
  the row from `proposed` to `active` so the recall filter sees it.
  When the env flag is unset (default), nothing changes — the legacy
  bridge in `normalizeMemoryInput` continues to derive the booleans
  from `category`, and the worker stays dormant.

  Projection rebuild now applies `memory.classified` events to the
  snapshot so a verdict survives a `pnpm rebuild` of the projection.
  Legacy-bridge writes carry `classified=1` on the snapshot (the
  worker has nothing to do); pendingClassification writes carry
  `classified=0`.

  New `scripts/migrate-enqueue-existing-memories.mjs` flips every
  existing row in `memories` to `classified=0, classification_attempts=0`
  so the worker drains the canonical instance's backfill queue
  post-cutover. Dry-run by default; `--apply` writes. Idempotent.

  **Halt gates on the canonical instance:** if the first 100
  classifications show `fallback_used: "max_retries"` rate > 20%
  (the spec §4.3 soft-alert threshold; dashboard banner surfaces
  it), HALT and investigate model configuration before continuing.
  The plan's §7.3 column drop + enum removal + dashboard-UI cleanup
  is deferred to 4d.2 (low-risk follow-up; runs after backfill is
  confirmed healthy).

- **Classifier evaluation surface (Section 4c of the rollout-completion plan).**
  New workspace package `@librarian/classifier-eval` ships the eval
  runner + a CLI bin (`classifier-eval run --provider remote --model
  <id> --sample 10 --category boundary`) and a soft-alert helper that
  computes the §4.3 max-retries rate over a window. The dashboard
  gains a `/classifier-eval` admin page that runs evals against a
  remote OpenAI-compatible endpoint (configured per-run via a form;
  persistent admin config arrives in 4d) and renders agreement
  metrics, per-category disagreement, latency distribution, and
  fallback counts. A banner appears at the top of the page when the
  recent classification window crosses the 20% max-retries threshold
  (spec §4.3). Each successful eval appends a
  `classifier.evaluation_completed` event (new `MemoryEventType`
  variant) so the timeline survives reloads. A 12-entry seed fixture
  at `packages/classifier-eval/fixtures/seed-v1.json` covers every
  verdict quadrant and includes boundary cases; the consensus-graded
  public fixture from spec §4.7 (~900 entries) lands in a follow-up.

  **No production behavior change.** Soft-alert returns zeros until
  Section 4d wires the worker into mcp-server startup so
  `memory.classified` events start flowing.

- **Classifier local provider (Section 4b of the rollout-completion plan).**
  `@librarian/classifier` now ships a `local` provider that runs GGUF
  models via [`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp)
  on a Node worker thread, keeping the mcp-server's event loop
  responsive while inference blocks. `node-llama-cpp` is declared as an
  `optionalDependency` so installs without local mode complete cleanly
  on platforms where the native build fails. A six-model catalog (spec
  §4.3 — Qwen 3.5 0.8B / LFM 2.5 1.2B Instruct + Thinking / Qwen 3.5
  2B / Phi-4-mini / Gemma 4 E2B; LFM 2.5 1.2B Instruct is the default)
  is committed at `packages/classifier/src/catalog.ts`. A new
  `runSelfTest()` helper exercises the classifier against a known
  identity-shaped memory and surfaces the raw model output on parse
  failure — the dashboard's custom-model save path uses it to reject
  configs that can't produce parseable JSON. The provider router now
  requires `deps.inferenceFor` for `provider: "local"` and `deps.llm`
  for `provider: "remote"` — misconfiguration throws at construction
  rather than silently returning conservative defaults. The 4a-era
  `LIBRARIAN_CLASSIFIER_LOCAL_STUB` env-flag escape hatch is retired —
  the local provider is now the production wiring.

  **Still no behavior change in production.** The worker
  (`createClassifierWorker`) is not wired into mcp-server startup;
  that lands in Section 4d.

- **Classifier foundation (Section 4a of the rollout-completion plan).**
  New workspace package `@librarian/classifier` with a remote (OpenAI-
  compatible) provider, the v1 prompt template, and the parser that
  folds every model output failure to a conservative-defaults verdict
  with a `fallback_used` tag (`parse` / `timeout` / `provider_unavailable`).
  Two new `memories` columns — `classified` and
  `classification_attempts` — both `INTEGER NOT NULL DEFAULT 0` (schema
  bump v14 → v15). A new `memory.classified` event variant on the
  ledger schema (spec §4.8). A new async worker scaffold at
  `packages/mcp-server/src/classifier-worker.ts` that drains the
  `classified = 0` queue, retries on parse / provider failures up to 3
  attempts, then gives up with conservative defaults + an event marked
  `fallback_used: "max_retries"`.

  **No behavior change.** The worker module exists but is NOT wired
  into mcp-server startup; no code path writes `classified = 0` yet,
  so the worker has nothing to do in production. New memories continue
  through the legacy `deriveLegacyMemoryFlags` path until Section 4d
  performs the cutover (with the migration backfill).

- **CLI `--conv-id` flag on `sessions start` (PR 5 of 8, T5.3 only).**
  Mirrors the new harness hook contract — when the operator pipes a
  series of CLI invocations together (e.g. `LIBRARIAN_CONV_ID=cli:work`
  in their shell), `sessions start` now inherits the domain from the
  matching `conversation_state` row. Single-domain installs continue
  to default to `general` through the §4.10 fast path. The Claude
  Code and Hermes plugin work (T5.1 + T5.2) lives in sibling repos
  and is out of scope for this PR.

- **Dashboard `/domains` page (PR 4 of 8, T4.1 only).** Owner-curated
  list of domains via a new admin tRPC router (`domains.list`,
  `domains.add`, `domains.remove`) on top of a `createDomainsStore`
  surface in `@librarian/core`. Removing a non-floor domain reassigns
  its memories to `general` rather than deleting them — agents can't
  lose content because the owner tidied up. The `general` floor cannot
  be removed (the §4.10 fast path depends on it). T4.2 (signal-rules),
  T4.3 (proposal modal), T4.4 (memory detail panel toggles), and T4.5
  (filter UI rewrite) deferred to follow-up sub-PRs per the plan's
  "split if any one task balloons" guidance.

- **Domain enforcement on memory + session writes (PR 3 of 8).** The
  `remember`, `recall`, `start_session`, and `continue_session` MCP
  tools now consume the conv-state registry from PR 2:
  - `remember` reads `conv_state.domain` for the supplied `conv_id` and
    server-sets the memory's `domain` accordingly. Calls without a
    matching conv_state row on a multi-domain install route to the
    proposal queue with `domain=NULL` and `requires_approval=true` per
    spec §4.14, so the dashboard owner picks the domain at approval
    time. The §4.10 single-domain fast path keeps zero-config installs
    zero-friction — when only `general` exists, the sole domain is
    auto-assigned without the proposal hop.
  - `recall` applies the §4.11 hard filter
    `(domain = current_domain OR is_global = 1) AND status = active`,
    drops the legacy `categories` and `include_private` inputs, and
    adds `tags` plus `include_other_domains`. Admin callers bypass the
    filter via the existing role flag.
  - `start_session` inherits its `domain` from the calling conv_state;
    `continue_session` seeds the resuming conv_state's domain from
    `session.domain` when a `conv_id` is supplied (skipping the
    signal-precedence chain on resume per §4.12).
  - `listMemories` (the dashboard read path) gains
    `domain` / `is_global` / `requires_approval` / `tags` filter axes
    alongside the existing surface.

- **Conversation-state registry and hook helpers (PR 2 of 8).**
  Per-conversation runtime state from spec §4.8 lands as a new SQLite-
  authoritative store on top of the `conversation_state` table from
  PR 1. The agent surface gains three MCP tools — `conv_state_get`,
  `conv_state_upsert`, `conv_state_clear` — that hook code in PR 5 will
  call every turn to defeat compaction-driven state loss. The pure
  helper `renderConvStateBlock(state)` returns the canonical
  `<conversation-state>` block from spec §4.9 byte-for-byte, so every
  harness integration reads one source of truth. No agent-visible
  behaviour change yet — PR 3 wires `remember` and `recall` to consume
  the registry.

- **Memory domain-isolation foundation (PR 1 of 8).** Additive schema for
  the new owner-controlled isolation model (`domain`, `is_global`,
  `requires_approval` columns on memories, `domain` on sessions, plus the
  four authoritative tables `conversation_state`, `domains`,
  `signal_rules`, `token_domain_bindings`). The two policy booleans are
  derived from the legacy `category` column as a temporary bridge until
  the write-path classifier ships in PR 6. The `general` domain is
  auto-seeded on first boot, and the `legacy-private` domain is
  synthesised on the fly by `scripts/migrate-add-domain-and-conv-state.mjs`
  for any historical `agent_private` memories. No behaviour change on
  reads or writes — existing tools see the new columns as defaulted
  metadata.

### Fixed

- **`rowToMemory` JSON-parse crash on corrupt `_json` columns.** A single
  corrupt `tags_json`, `applies_to_json`, `supersedes_json`,
  `conflicts_with_json`, or `curator_note` column in the SQLite `memories`
  table would crash every query that reads memory rows (`listMemories`,
  `listAll`, `getMemory`) with an uncaught `SyntaxError`, manifesting as a
  500 / JSON-RPC -32603 on the dashboard and MCP calls. The read path now
  wraps each `JSON.parse` in defensive helpers that log the corruption to
  stderr and fall back to safe defaults (`[]` or `null`) — one bad row no
  longer blocks the user's turn (fail-soft principle).

### Added

- `AGENTS.md` with the family-wide house rules (privacy, fail-soft,
  cross-repo contracts, etc.) and the main-repo build / test / gotcha
  notes. Sibling AGENTS.md files in the four standalone plugin repos
  share the same baseline so an agent dropped into any repo of the
  family behaves consistently.

### Changed

- **README front-loaded with the harness integrations section.** Moved
  the section to sit immediately before `## Features` so the install
  commands are the first concrete thing readers see (was previously
  buried below CLI / Curator). Each of the five harnesses gets a
  brand-coloured shields.io badge (Claude Code terracotta with the
  Anthropic mark, Codex purple with the OpenAI mark, Hermes gold with
  the dark LobeHub Hermes icon embedded via base64, OpenCode npm
  orange with the npm mark, Pi blue) plus a collapsible `<details>`
  block with the exact install one-liner — no need to navigate to the
  plugin repo for a basic install. The "Harness integrations" bullet
  in the Features list dropped (now redundant with the section right
  above).

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
