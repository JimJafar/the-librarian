# Changelog

All notable changes to **The Librarian** are documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This changelog starts at v0.1.0 — the first version likely to see public
adoption. The pre-v0.1.0 development history lives in the git log; only
changes from this point forward are catalogued here.

## [Unreleased]

### Fixed

- **The vault always gets its own git repo, even when nested in another checkout.**
  The store inits the vault as a git repo (a commit per write), but the init guard
  treated "inside *any* repo" as done — so a data dir placed under an existing git
  checkout skipped init and committed every memory write into that *parent* repo
  (running `git add -A` over its whole working tree). The guard now checks whether
  the vault is its own repo *root*, creating a dedicated repo when nested. A
  standalone/Docker `./data` was unaffected; this only bit vaults under a checkout.

- **Recall no longer re-embeds the whole corpus on every write.** The disposable
  recall index is rebuilt (and every active memory re-embedded) whenever a memory
  is written; a bulk groom — consolidating many inbox items one at a time — did
  that once per item over a growing corpus, i.e. O(N²) embeddings. Under the real
  CPU model (EmbeddingGemma) that made a large groom (e.g. a seed import of a few
  hundred memories) glacial. The store now memoizes document embeddings by content
  across rebuilds, so each distinct memory embeds once per sweep (O(N)); queries
  are never cached.

- **Recall no longer crashes on long documents.** EmbeddingGemma threw "Input is
  longer than the context size" on any doc over its ~2048-token window, failing
  the consolidator's navigate step for that item. Long inputs are now truncated to
  the model's context window before embedding (a truncated embedding still
  captures the gist for recall).

### Changed

- **Consolidator curation prompt → v2.** The judge prompt now states the
  *judgement* behind a filing choice, not just the output contract: preserve over
  rewrite (augment rather than supersede unless genuinely contradicted), calibrate
  confidence honestly so an ambiguous-entity merge scores low (and files fresh
  rather than clobbering the wrong target), resolve entities cautiously, and file
  for retrieval (`[[wikilink]]` both sides of a multi-entity fact). Affects only
  the opt-in consolidator; `CONSOLIDATOR_PROMPT_VERSION` bumped v1 → v2.

- **The shipped server + CLI now default to the markdown backend** (the plan-036
  cutover): the git-backed vault for memories/handoffs, sidecar JSON for
  conv-state/settings, the disposable hybrid index for recall. `LIBRARIAN_BACKEND=sqlite`
  is the explicit opt-out. The Docker images now include `git` (the markdown
  backend commits every write). A residual SQLite db still backs the dormant
  curator until Phase 4. **Upgrading:** existing data in `librarian.sqlite` is
  NOT auto-migrated to the vault yet (the migration tool is a follow-up) — an
  upgraded install defaults to an empty markdown vault; set `LIBRARIAN_BACKEND=sqlite`
  to keep using your existing data until migration lands.

### Added

- **`@librarian/consolidator-eval` — the consolidator evaluation harness.** An
  operator-driven package (mirroring `@librarian/classifier-eval`) that scores the
  consolidator's `navigate → judge → route` pipeline against S1/S2/S4/S12/S18
  fixtures: filing accuracy, decision-band routing, no-clobber of hand-authored
  prose (S18), contradiction-recall (S4), and entity-resolution under ambiguity
  (S12). Ships a `consolidator-eval` CLI with a frozen-baseline regression gate
  (`--update-baseline` / `--baseline … --gate`). Not part of CI (it calls a real
  model); its own tests drive the pipeline with a deterministic scripted model.

- **The consolidator — opt-in async memory filing (plan-036 Phase 4).** With
  `LIBRARIAN_CONSOLIDATOR=on` on the markdown backend, `remember` becomes a
  fire-and-forget submission: the note is queued to a vault inbox and an LLM
  consolidator files it asynchronously (navigate the existing memories → judge
  whether to augment/supersede an existing one or create a new memory →
  minimal-edit in place, preferring `[[wikilinks]]` over duplication), carrying
  the submitter's `agent_id`/`project_key`/`tags`/`applies_to`. A serial scheduler drains the
  inbox on a cadence (`LIBRARIAN_CONSOLIDATOR_TICK_MS`, default 5 min) plus a
  boot scan; it shares the curator's LLM brain config. **Default off** — when
  disabled (or on the sqlite backend, which has no vault inbox), `remember` keeps
  its existing direct-write behaviour unchanged.

- **EmbeddingGemma wired as the production embedder** for index recall +
  `search_references` (`resolveEmbedder`). Selection is env-driven:
  `LIBRARIAN_EMBEDDER=hash|llama` (default: hash under tests, the EmbeddingGemma
  model otherwise). The GGUF (`EmbeddingGemma-300M-Q8_0`, ~333 MB) is downloaded
  + cached lazily on first embed under `<dataDir>/models`, or supply your own via
  `LIBRARIAN_MODEL_PATH`. The model loads only on first use, so nothing downloads
  during boot/healthcheck.

- **`search_references` MCP tool (F3/F4).** Tier-0 lookup over the vault's
  `references/` — background reference docs that are deliberately kept out of
  normal recall. Returns each match's path + the query-relevant section (so the
  agent pulls just the matched section, not the whole file). Backed by the
  disposable hybrid index; backend-independent (references live in the vault).

- **Real embedding model via `node-llama-cpp` (F2).** `createLlamaEmbedder` runs a
  GGUF embedding model on CPU (default **EmbeddingGemma-300M**, 768-dim, multilingual)
  behind the pluggable `Embedder` interface, with asymmetric query/document prompts
  (`embedQuery`). It's lazy-loaded, so the bundled deterministic hash embedder stays
  the zero-dependency default for tests/CI and nothing loads the native binary until
  the model is actually used. The GPU (CUDA/Vulkan) prebuilt binaries are stripped at
  install via `.pnpmfile.cjs`, keeping the dependency footprint ~60 MB.

- **Skills (read surface) — `find_skills`, `get_skill` MCP tools (F7).** Skills live
  as `skills/<slug>/SKILL.md` (+ optional `resources/`) in the vault; `find_skills`
  ranks the manifest (name + description) against a query, and `get_skill` returns a
  skill's full document plus its resource file list. Backend-independent (vault-based),
  fail-soft on bad input. Semantic ranking currently uses the bundled deterministic
  embedder; the production model is a drop-in via the same interface.
- **`session_manifest` MCP tool (F6, server side).** Returns the session-start
  manifest the client hook consumes: the working-style preamble (from the
  `working_style` setting) plus a bounded skills manifest.

### Changed

- **`recall` is no longer domain-scoped (D16, memory side).** Results rank by
  relevance across all memories instead of being filtered to the caller's
  conversation domain; the `conv_id` and `include_other_domains` arguments are
  removed from `recall`, and `remember` no longer derives or routes writes by
  domain. This is the first step of removing memory-domain-isolation entirely
  ("relevance from retrieval, not walls"); the `domains` management surface,
  handoff/conv-state scoping, and the SQLite domain columns are removed in
  follow-up D16 PRs.
- **Handoffs are no longer domain-scoped (D16).** `store_handoff` / `list_handoffs` /
  `claim_handoff` and the dashboard + CLI handoff views drop the per-domain isolation
  and the `conv_id` / `domain` arguments; the shared `domain-resolution` helper is
  removed. (The vestigial `handoffs.domain` column is dropped with the rest of the
  schema in the final D16 PR.)
- **The domain model is fully removed (D16, final step).** The owner-managed
  `/domains` dashboard page (and its tRPC `domains` router) is gone; conversation
  state no longer carries a `domain` (the `conv_state_upsert` tool and the per-turn
  `<conversation-state>` block drop the field, and first-create now requires only
  `harness`). The SQLite schema drops the `domains` / `signal_rules` /
  `token_domain_bindings` tables and the `domain` column from `memories`,
  `conversation_state`, and `handoffs` (projection schema version 21); existing
  databases migrate automatically on next open. Relevance now comes from retrieval,
  not domain walls.
- **`handoffs show --json` now emits the normalized handoff shape.** The CLI
  `the-librarian handoffs show --json` output uses `handoff_id` / `tags` (array) /
  `claimed_by` (object) instead of the raw database columns (`id` / `tags_json` /
  `claimed_by_json`). This falls out of routing the dashboard `handoffs.byId` view
  and the CLI through a new `HandoffStore.getById` rather than raw SQL — the first
  step of sealing the storage seam (F0) for the markdown rearchitecture.
- **`the-librarian rebuild` output is backend-neutral.** The command now reports
  "Rebuilt the memory index in &lt;data-dir&gt;" (was "Rebuilt projection from
  &lt;events.jsonl path&gt;"), and its help line reads "Rebuild the memory index from
  stored data". Same behaviour; the wording no longer names the SQLite/events-ledger
  internals, via a new backend-neutral `reindex()` store verb (F0).

## [0.4.0] — 2026-05-30

### Added

- **Backups cockpit on the dashboard.** The `/backups` page now manages the whole
  backup lifecycle: a config form (cloud target — S3 or GitHub — with write-only
  credentials, schedule, retention, and an optional failure webhook), a health
  banner (last successful backup / last failure), the recent bundles with one-click
  **restore** (restart-staged, with the supervisor warning), and a run-history
  table. No redeploy needed to change any of it.

- **Restore a backup from the dashboard (restart-staged).** Staging a restore
  validates the chosen bundle (pulling it from the cloud target if it isn't
  local) and queues it; it's applied on the next server boot — before the SQLite
  file is opened, never under a live connection. A failed restore leaves the live
  data untouched and keeps the marker for the operator. The admin API gains
  `backup.stageRestore` and a `backup.restart` control.

- **GitHub Releases as a backup target.** Alongside S3-compatible storage, a
  backup can now sync to a (private) GitHub repo: each bundle becomes a Release
  (tag = bundle name) with the bundle's files attached as release assets. No new
  dependency — it uses Node's built-in `fetch`; the fine-grained token is stored
  encrypted and never appears in URLs, logs, or errors. Configure via
  `backup.github.repo` / `backup.github.token` (dashboard or the
  `LIBRARIAN_BACKUP_GITHUB_REPO` / `LIBRARIAN_BACKUP_GITHUB_TOKEN` env vars).
- **Dashboard-managed backup schedule + run health.** The backup cadence,
  target, retention count, and an optional failure-alert webhook now live in
  admin settings (no redeploy to change). Each scheduled or manual backup
  records a `backup_runs` row (status, target, bytes, error, timestamps); the
  server runs a backup once the configured interval has elapsed, recovers a run
  left in-flight by a crash, and POSTs a generic-JSON alert to the webhook on
  failure. The schedule ships disabled by default; the legacy
  `LIBRARIAN_BACKUP_INTERVAL_MS` still enables backups for headless installs.

### Changed

- **Backup bundles are now gzipped (`format_version` 2).** Each file in a
  backup bundle (`librarian.sqlite`, `events.jsonl`, `memories.md`) is stored
  gzipped as `<name>.gz`, cutting bundle size by roughly 70% (the SQLite copy is
  mostly empty pages). The manifest records both the stored (compressed) and the
  uncompressed sha256/bytes per file. `restore` is backward-compatible — existing
  `format_version` 1 (uncompressed) bundles still restore — and now bounds
  decompression to each file's declared uncompressed size, refusing a malformed
  or zip-bomb `.gz` before it can exhaust memory.

## [0.3.0] — 2026-05-29

### Added

- **Classifier admin cockpit at `/classifier`.** Operators configure
  the classifier worker (remote LLM connection, prompt version, enable
  flag) from the dashboard the same way they configure the curator. The
  page shows a configuration summary with a "Config has changed since
  the worker started" drift banner; a form with the LLM-connection
  fields and a masked token input that preserves the stored value on
  empty submit; a restart button that calls the new
  `classifierConfig.restartWorker` mutation (coalesces concurrent
  callers via the single-flight mutex documented in the spec); and a
  self-test button that runs the classifier package's
  `runSelfTest(SELF_TEST_INPUT)` against a transient classifier
  instance, returning verdict + latency + fallback reason. Worker
  drift detection uses a sha256 of the encrypted token blob so token
  rotation flips the hash without ever touching plaintext.
- **`@librarian/core` shared `llm-connection` helper.** The
  per-LLM-connection block (provider/endpoint/model/timeoutMs +
  encrypted token) used by both the curator and the new classifier
  config is now a single tested module. Curator-config delegates to
  it; classifier-config layers an enable flag + prompt version on top.
  Public surface:
  `LlmConnection`, `LlmConnectionPatch`, `LlmConnectionPatchSchema`,
  `llmConnectionKeys`, `readLlmConnection`, `writeLlmConnection`,
  `resolveLlmToken`.
- **`@librarian/core/classifier-config`.** Settings-store-backed
  config for the classifier worker.
  `readClassifierConfig` / `writeClassifierConfig` /
  `resolveClassifierToken` / `classifierConfigHash` /
  `findLegacyClassifierEnvKeys` / `ClassifierConfigPatchSchema`. The
  hash includes a sha256 fingerprint of the encrypted token blob, so
  rotation triggers drift without exposing plaintext.
- **`@librarian/mcp-server` store-driven classifier boot + restart +
  self-test.** `bootClassifierWorker({ store, … })` reads the stored
  config; `restartClassifierWorker(input)` implements the nine-step
  shutdown procedure with a single-flight mutex
  (outcomes: `started | stopped | restarted | already_in_progress |
  failed`); `runClassifierSelfTest(input)` builds a transient
  classifier, runs the fixture, and returns the result.
- **`classifierConfig` tRPC router** mounted on `appRouter`:
  `config` / `setConfig` / `workerState` / `restartWorker` /
  `selfTest`. All admin-gated; token never on the wire.

### Removed

- **Embedded local classifier provider (`node-llama-cpp`).** The
  in-process GGUF provider shipped in v0.2.0 — the `node-llama-cpp`
  optional native dependency, the Node-Worker inference host, the
  curated model `CATALOG`, the HuggingFace download plumbing, and the
  `providerMode` config discriminator — is removed. The classifier is
  **remote-only**: point the LLM connection at any OpenAI-compatible
  endpoint, including a self-hosted **ollama / vllm / llama.cpp** server
  URL, for local inference. This drops a ~300MB native dependency that
  never installed in the read-only Docker image anyway. No migration
  needed — a stored `provider_mode = "local"` reads back as remote and
  reports "not operational" until an endpoint is configured; orphaned
  `classifier.local.*` settings are ignored. `ClassifierConfig` loses
  its `providerMode` and `local` fields (`isOperational === enabled &&
  isLlmComplete`), so the config hash changes once, showing a one-time
  drift banner cleared by a worker restart. `classifier-eval`'s
  `--provider` now accepts only `remote`.
- **`LIBRARIAN_CLASSIFIER_*` env vars retired** in favour of admin-
  settings persistence (see the cockpit above). Boot logs a one-line
  `classifier_env_retired` notice if any of the seven retired keys
  (`_ENABLED`, `_PROVIDER`, `_REMOTE_ENDPOINT`, `_REMOTE_TOKEN`,
  `_REMOTE_MODEL`, `_LOCAL_MODEL`, `_LOCAL_QUANT`) are still set, with
  a hint to migrate to the cockpit. A new CI guard
  (`scripts/check-classifier-env-retirement.mjs`, wired into the
  guards job) `git grep`s the repo for new references and fails the
  build on any occurrence outside the explicit allowlist (the
  retirement-related source / tests / docs + classifier-eval's
  separate CLI env contract + the `_LOCAL_E2E` integration-test
  flag).

## [0.2.0] — 2026-05-28

### Fixed

- **v18 → v19 sessions-rethink migration crash on boot.** The PR 7
  drop-and-rebuild path tried to pre-drop the FTS5 shadow tables
  (`session_events_fts_data` etc.) before the parent virtual table,
  which SQLite refuses (`table … may not be dropped`). The first
  statement threw and `ensureSchema` aborted, leaving the server
  unable to start against any v18 database. Fix drops only the
  virtual table — SQLite cleans up its shadows atomically — wrapped
  in try/catch in case an exotic half-migrated DB has an orphan
  `session_events_fts` row in `sqlite_master` without shadows.
  Reported by the Hermes deploy at startup. Regression test pins the
  v18 → v19 path.

### Added

- **Responsive memories page + hamburger nav on small screens.** The
  memories page outer grid now stacks below `lg` (1024px) — the
  filter sidebar collapses above the list with a
  `<details>`-driven "Filters & recall" toggle, so a phone-sized
  viewport gets a usable list column instead of a 30px sliver. The
  site nav swaps `flex flex-wrap` for a hamburger pattern below `md`
  (768px) — inline SVG icon with `aria-expanded` / `aria-controls`,
  drawer below the bar when open, auto-closes on route change. The
  right-hand controls (version badge, theme toggle, sign-out) stay
  visible at every width.
- **Release runbook + per-repo release docs.** Canonical cross-family
  release procedure lives at
  [`docs/release-runbook.md`](docs/release-runbook.md); the per-repo
  steps and decision rules at [`docs/release.md`](docs/release.md).
  AGENTS.md thinned to point at both — the bump-size rule and
  per-procedure steps no longer duplicate inline. Sibling plugin repos
  pick up matching `docs/release.md` files that cross-link to the
  monorepo runbook.

### Removed

- **Session subsystem retired (sessions-rethink PR 7).** The thirteen
  session MCP tools (`start_session`, `get_session`, `list_sessions`,
  `list_session_events`, `search_sessions`, `record_session_event`,
  `checkpoint_session`, `pause_session`, `end_session`, `attach_session`,
  `continue_session`, `promote_session_fact`, plus the older retired
  `archive_session` / `restore_session` / `delete_session`) are gone.
  The CLI's `the-librarian sessions <verb>` family, the dashboard's
  `/sessions` and `/sessions/[id]` surfaces, the `lib-session-*` and
  `lib-toggle-private` slash commands, the `sessionsRouter` tRPC
  surface, the session formatters (`renderHandover*`), the
  `scripts/check-session-state-divergence.mjs` /
  `scripts/migrate-sessions-to-authoritative-sqlite.mjs` scripts, and
  the corresponding healthcheck probe are all retired. Plugin repos
  have already been trimmed in parallel PRs (claude-plugin #12,
  codex-plugin #6, opencode-plugin #6, hermes-plugin #21,
  pi-extension #10) — they now register only the conv-state injection
  hook and rely on the `/handoff`, `/takeover`, `/learn`,
  `/toggle-private` slash surface for cross-harness continuity.
  **Schema break:** projection bumps 18 → 19 and drops the
  `sessions`, `session_state_changes`, `session_events`, and
  `session_events_fts*` tables. Existing memory data is unaffected
  (events.jsonl is the source of truth); leftover
  `session_events.jsonl` / `sessions.legacy.jsonl` files are renamed
  to `.predeprecation.bak` on next open so operators can see they've
  been retired but no data is silently deleted. Older backup bundles
  carrying the old ledger files restore cleanly — the post-PR-7 store
  ignores them on open.

### Added

- **Dashboard version badge with "behind latest" indicator.** A small
  `v<version>` chip in the nav bar shows the running build's version
  (read from the root `package.json` at boot, surfaced via a new public
  `health.info` tRPC procedure). A coloured dot + native browser
  tooltip indicates whether the local build is up to date, behind the
  latest GitHub release, or in a "couldn't check" state (no releases
  yet, rate-limited, or the host is offline). Clicking the badge opens
  the matching release notes in a new tab. The GitHub lookup is cached
  for an hour, lifts to 5000 req/h when `LIBRARIAN_GITHUB_TOKEN` is
  set, and can be disabled entirely with
  `LIBRARIAN_DISABLE_VERSION_CHECK=true` for air-gapped instances.
  Downstream forks can point the check at a different repo via
  `LIBRARIAN_GITHUB_REPO=org/repo`.
- **Handoffs surface (sessions-rethink PR 1, additive).** Three new MCP
  tools — `store_handoff`, `list_handoffs`, `claim_handoff` — back a new
  `handoffs` SQLite table that records self-contained narrative handoffs
  for cross-harness pickup. The atomic `claim_handoff` wraps an UPDATE +
  SELECT in `BEGIN IMMEDIATE` so two concurrent claimants always pick a
  single winner (404 vs 409 distinguish unknown rows from already-claimed
  ones). Server-side domain isolation matches the memory tools.
  Companion surfaces: a `the-librarian handoffs <list|show|purge>` CLI
  family (purge is admin-only), a read-only dashboard at `/handoffs`
  with a list view + detail view (no claim button — that's an agent
  operation), and four new Claude Code slash commands
  (`/handoff`, `/takeover`, `/learn`, `/toggle-private`) shipping the
  agent-side contract from spec §6.5. Healthcheck allow-list updated.
  **The old session surface (13 MCP tools, `lib-session-*` commands) is
  untouched** — both surfaces live side-by-side until PR 7 removes the
  old one. Schema bumps 17 → 18; the new table is authoritative and
  preserved across future projection rebuilds.

### Changed

- **Memory curator decouples from sessions (sessions-rethink PR 0).** The
  curator is now memory-only. The session-evidence path
  (`gatherSessionEvidence`, `SessionEvidenceBundle`, `source_session_ids`,
  `input_session_ids`) is gone from `curator-evidence.ts`,
  `curator-worker.ts`, `curator-prompt.ts`, `curator-output.ts`,
  `curator-validate.ts`, `curator-apply.ts`, and the curation-store
  schemas. The session-derived `safe` discriminator (and the implicit
  "strong session-backed evidence" shortcut for `create`) is retired;
  exact-duplicate `safe` survives. Curation runs no longer hash session
  ids into their input fingerprint. **Schema break:** projection bumps
  16 → 17 and drops `memory_curation_runs.input_session_ids` and
  `memory_curation_operations.source_session_ids` via
  `ALTER TABLE … DROP COLUMN`. Existing curation rows are preserved;
  the columns just disappear.
- **Curator cadence is disabled by default with an explicit operator
  opt-in (§12.4).** The legacy `curator.schedule.interval_days` /
  `curator.schedule.time` / `min_sessions_since_run` keys are retired
  and replaced by `curator.interval_minutes` (default 60, capped at one
  week). When `curator.enabled` is `false` (the default), the scheduler
  ticks but does nothing — no LLM calls, no runs created. When enabled,
  the scheduler runs every `curator.interval_minutes` from the slice's
  last completion; the previous self-gate on new-session counts is
  retired (sessions no longer drive the curator). Boot logs a one-line
  notice if legacy schedule keys are still in settings so operators
  know to migrate. Dashboard cockpit config form replaces the
  "every N days at HH:MM" inputs with a single "every N minutes" field.

### Added

- **`classifier-eval generate-fixture` CLI (Task 4.10).** Implements
  the spec §4.7 public-consensus fixture generation pipeline:
  generate ~1500 candidate memories via one strong LLM, run each
  through 3 frontier graders from different model families (Claude /
  GPT / Gemini) via the classifier's own v1 prompt, keep only
  unanimous candidates, trim to ~900 maintaining the 60/40 ratio,
  iterate if a bucket falls short. Configurable via a JSON file
  (`fixtures/graders.example.json` ships as a template) with tokens
  resolved from env-var references so the config is safe to commit.
  Hard `--max-calls` budget guard prevents runaway API spend; verbose
  per-iteration progress logging via `--verbose`; dry-run mode
  validates config + env without making any calls. The fixture
  itself is NOT generated in this PR — that's an operator one-shot
  with three API keys in hand (~$5 spend). 28 new unit tests cover
  consensus, ratio-preserving trim, generator prompt construction,
  CLI flag parsing, and an end-to-end pipeline test with in-memory
  fake clients. Documented in `packages/classifier-eval/README.md`.

### Removed

- **Legacy `category` / `visibility` / `scope` columns + dashboard
  dropdowns + `PROTECTED_CATEGORY_STRINGS` gate inside the store
  (Section 4d.3 final cleanup).** The schema bumps to v16 — the
  `memories` table loses three columns; the FTS table loses its
  `category` column. New writes don't carry those fields; legacy
  ledger events still parse (the projection ignores those fields on
  rebuild). Memory-side `visibility` is gone end to end; sessions
  still carry it for cross-agent handover.

  The curator's protected-routing rebased onto the
  classifier-decided `requires_approval` flag: the apply layer emits
  `options.requires_approval: true` for protected creates, the
  validate layer reads `requires_approval` on each evidence item
  (`category` is no longer carried on `MemoryEvidenceItem`).

  `createMemory` exposes an `options.requires_approval: boolean` (and
  `options.is_global`) channel for trusted internal callers (curator,
  dashboard, tests). Agent-supplied values via `input.requires_approval`
  are still ignored per spec §4.1/§4.4. The legacy
  `legacyProtected` short-circuit inside the store is retired.

  Dashboard UI: `NewMemoryForm`, `MemoryDetailPanel`, `MemoriesFilters`,
  `PromoteForm`, and the `(memories)/actions.ts` server actions all
  drop their category/visibility/scope inputs. The detail panel now
  surfaces `is_global` / `requires_approval` / `domain` pills built
  from the classifier verdict instead.

  Migration `scripts/migrate-add-domain-and-conv-state.mjs` is now a
  no-op on post-4d.3 schemas (legacy backfill target columns gone);
  it prints a clear message and exits cleanly.

- **Legacy `Category` / `Scope` enums + `deriveLegacyMemoryFlags` /
  `isProtectedCategory` (Section 4d.2 cleanup).** The classifier
  worker is now the source of truth for `is_global` and
  `requires_approval`; the legacy category-derived bridge is retired.
  `category` / `visibility` / `scope` remain as opaque free-text
  columns on the `memories` table for backward compatibility with
  pre-cutover ledger events; the projection no longer treats them as
  routing signals.

  Curator output schemas (`CuratorMemoryInputSchema`,
  `CuratorMemoryPatchSchema`) widen `category` / `scope` to
  `z.string()`. The `PROTECTED_CATEGORY_STRINGS` set survives as a
  legacy gate inside `createMemory` so identity / relationship
  strings still route to `requires_approval=true`+`status=proposed`
  until callers (curator apply, dashboard new-form) switch to
  emitting `requires_approval=true` directly.

  `startContext` is rewritten to bucket by `is_global=true` +
  agent-private rather than by category enum members.

  **No production behaviour change** beyond what Section 4d.1
  already shipped — the worker still decides the booleans on the
  write path; this PR retires the dead bridge code.

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

[Unreleased]: https://github.com/JimJafar/the-librarian/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/JimJafar/the-librarian/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/JimJafar/the-librarian/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/JimJafar/the-librarian/releases/tag/v0.1.0
