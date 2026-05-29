---
title: Sessions rethink — implementation plan
status: ready-to-execute
plan_version: 1.0
created: 2026-05-28
related_docs: sessions-rethink.md (brainstorm), 029-sessions-rethink-spec.md (v1.1)
---

# Sessions rethink — implementation plan

> Ordered task breakdown for autonomous execution. Each PR is independently mergeable and revertable. The agent picks up PRs in order, runs the tasks inside, opens the PR against `main`, waits for CI green, asks for human review/merge, then moves to the next.

---

## Overview

Eight PRs in two streams:

1. **Monorepo (`~/code/the-librarian`)** — PR 0, PR 1, PR 7. Sequenced: prep, additive, destructive.
2. **Plugins** — PR 2–6, one per repo. Each depends on PR 1 being deployed (so the new MCP tools exist at runtime).

```
PR 0 (curator decouple) ──→ PR 1 (add handoffs) ──→ Dev deploy ──→ PR 2..6 (plugins) ──→ PR 7 (cleanup)
   monorepo                    monorepo                              one repo each       monorepo
```

Plugins (PR 2–6) can land in any order after PR 1 is deployed. For autonomous execution, I'll do them sequentially in the order: Claude → Codex → OpenCode → Hermes → Pi.

---

## Architecture decisions (locked)

| # | Decision | Source |
|---|---|---|
| AD-1 | Eight additive-then-destructive PRs; never destructive before additive | Plan-phase Q1 |
| AD-2 | Curator `safe` tier preserved for exact-duplicate path; only session-derived `safe` removed | Plan-phase Q2, spec §12.3 |
| AD-3 | Curator disabled by default; operator opts in via config | Plan-phase Q3, spec §12.4 |
| AD-4 | `makeId("hdo")` for handoff IDs (existing pattern) | Code reading |
| AD-5 | New handoffs schema added in `initSchema` at `packages/core/src/store/projection.ts`; `PROJECTION_SCHEMA_VERSION` bump 16 → 17 | Code reading |
| AD-6 | CLI: top-level `handoffs-list.ts` / `handoffs-show.ts` / `handoffs-purge.ts` files in `packages/cli/src/commands/`; register via a `handoffVerbs` Record in `commands/index.ts` and a `handoffs` dispatcher in `runtime.ts` (parallel to existing `sessionVerbs`) | Code reading |
| AD-7 | tRPC: new `handoffsRouter` at `packages/mcp-server/src/trpc/handoffs.ts`; registered in `appRouter` at `trpc/router.ts` | Code reading |
| AD-8 | Dashboard tests under `apps/dashboard/tests/components/`, not colocated | Code reading |

---

## Cross-PR conventions

- **Branch naming:** `feat/sessions-rethink-prN-<slug>` (e.g. `feat/sessions-rethink-pr0-curator-decouple`).
- **PR titles:** start with the same identifier, then describe scope (e.g. `feat(curator): decouple from sessions (PR 0/7)`).
- **Commit conventions:** Match existing repo style: `<type>(<scope>): <subject>` (e.g. `refactor(curator): drop session evidence path`).
- **Tests:** Each task either updates existing tests or adds new ones. CI must be green before opening the PR.
- **Verification gates:** Every PR ends with one full gate: `pnpm typecheck && pnpm lint && pnpm test && pnpm smoke` (monorepo) or repo-native equivalent.
- **No force pushes** to main per Jim's global CLAUDE.md. All work via PR.
- **Each PR must include** a CHANGELOG entry describing the change.
- **Stop conditions:** if a verification gate fails and the cause is non-obvious, stop and report rather than push fixes blindly.

---

## PR 0 — Curator decouples from sessions

**Branch:** `feat/sessions-rethink-pr0-curator-decouple`
**Repo:** `the-librarian`
**Scope:** Curator becomes memory-only. Sessions still exist; the curator just stops reading them. Disabled-by-default cadence introduced.
**Dependencies:** none (clean main).

### Tasks

#### Task 0.1: Remove session-evidence gathering (S)

**Description:** Delete the curator's session-reading path. Replace the evidence bundle with a memory-only equivalent.

**Acceptance criteria:**
- [ ] `packages/core/src/curator-evidence.ts` deleted entirely.
- [ ] `packages/core/src/curator-worker.ts` no longer imports from `curator-evidence`; evidence bundle constructed from memory only.
- [ ] No reference to `gatherSessionEvidence`, `SessionEvidenceBundle`, `SessionRow`, `SessionEventRow`, `DEFAULT_MAX_EVENTS_PER_SESSION` anywhere in the package.

**Verification:**
- `pnpm --filter @librarian/core typecheck` clean.
- `rg "SessionEvidence|gatherSessionEvidence" packages/core/src/` returns nothing.

**Files:** `packages/core/src/curator-evidence.ts` (delete), `packages/core/src/curator-worker.ts` (modify).

#### Task 0.2: Drop `source_session_ids` from curator op schemas (S)

**Description:** Remove the field from Zod schemas and the apply pipeline.

**Acceptance criteria:**
- [ ] `packages/core/src/curator-output.ts` Zod schemas no longer include `source_session_ids` on `create` or `archive` ops.
- [ ] `packages/core/src/curator-apply.ts` no longer references `source_session_ids`.
- [ ] `packages/core/src/curator-validate.ts` line 333 (the session-derived `safe` discriminator) removed; exact-duplicate `safe` path at lines 327–330 preserved.

**Verification:**
- `rg "source_session_ids" packages/core/src/` returns nothing.
- `pnpm --filter @librarian/core typecheck` clean.
- Unit tests for curator-validate still pass (specifically the exact-duplicate-safe test, if it exists; add one if not).

**Files:** `packages/core/src/curator-output.ts`, `packages/core/src/curator-apply.ts`, `packages/core/src/curator-validate.ts`.

#### Task 0.3: Rewrite curator prompt to drop session framing (XS)

**Description:** The LLM prompt currently instructs the curator to "create memories for durable facts evidenced by sessions." Rewrite to "review and consolidate existing memories." Drop session schema references.

**Acceptance criteria:**
- [ ] `packages/core/src/curator-prompt.ts` contains no instances of "session" in any user-facing string.
- [ ] The op schema description shown to the LLM does not mention `source_session_ids`.

**Verification:**
- `rg "session" packages/core/src/curator-prompt.ts` returns nothing.
- Curator prompt smoke test (if exists) still produces parseable output.

**Files:** `packages/core/src/curator-prompt.ts`.

#### Task 0.4: Disable-by-default cadence (M)

**Description:** Replace `min_sessions_since_run` with an explicit on/off config, default off. When on, run on a time interval.

**Acceptance criteria:**
- [ ] New config keys: `curator.enabled` (boolean, default `false`) and `curator.interval_minutes` (number, default 60). Match existing config naming/loading convention — read the existing `curator-config.ts` first to mirror its style.
- [ ] `packages/core/src/curator-schedule.ts` and `curator-scheduler.ts` drop `min_sessions_since_run`, `newSessionCount`, and `sessionFilter` references.
- [ ] When `curator.enabled` is `false`, the scheduler is a no-op (does not tick).
- [ ] When `curator.enabled` is `true`, the scheduler runs on the configured interval.
- [ ] Boot logs a one-line notice if a legacy `min_sessions_since_run` config value is present and being ignored.

**Verification:**
- New unit tests: enabled=false → no run; enabled=true with short interval → tick observed.
- `rg "min_sessions_since_run|newSessionCount|sessionFilter" packages/core/src/` returns nothing.

**Files:** `packages/core/src/curator-schedule.ts`, `packages/core/src/curator-scheduler.ts`, `packages/core/src/curator-config.ts` (if exists; otherwise wherever config is loaded).

#### Task 0.5: Drop session columns from curation-store (S)

**Description:** Remove `input_session_ids` and `source_session_ids` columns from `curation_runs` and `curation_ops` tables.

**Acceptance criteria:**
- [ ] `packages/core/src/store/curation-store.ts` schema no longer defines `input_session_ids` or `source_session_ids` columns.
- [ ] Migration: bump curation-store internal schema version; drop the columns via `ALTER TABLE … DROP COLUMN` (SQLite ≥3.35) inside the existing migration path.
- [ ] All read/write paths in `curation-store.ts` updated to omit the columns.

**Verification:**
- `rg "source_session_ids|input_session_ids" packages/core/src/store/curation-store.ts` returns nothing.
- Curation-store tests pass.

**Files:** `packages/core/src/store/curation-store.ts` (+ its test file).

#### Task 0.6: Strip session paths from curator-redaction (XS)

**Description:** If `curator-redaction.ts` only redacts session summaries, delete it. Otherwise strip the session-only paths.

**Acceptance criteria:**
- [ ] No reference to session summaries in `curator-redaction.ts`.
- [ ] If the entire module became dead code, delete and remove imports.

**Verification:** typecheck clean.

**Files:** `packages/core/src/curator-redaction.ts`.

#### Task 0.7: Update curator tests (M)

**Description:** Curator tests fixture session rows; strip those fixtures and add memory-only equivalents.

**Acceptance criteria:**
- [ ] `packages/core/tests/curator-evidence.test.ts` deleted.
- [ ] Curator integration tests (likely in `packages/core/tests/` and `packages/mcp-server/tests/`) updated to fixture only memory rows.
- [ ] New tests cover: enabled=false scheduler no-op, enabled=true tick on interval, curator op without `source_session_ids` passes apply pipeline.
- [ ] `test/baseline.json` count adjusted to new total (run `pnpm test` and update the count to whatever is observed).

**Verification:** `pnpm test` green; `pnpm check:test-count` green.

**Files:** Several test files in `packages/core/tests/curator-*.test.ts`, `packages/mcp-server/tests/`, `test/baseline.json`.

#### Task 0.8: PR finalisation (S)

**Description:** Final verification, CHANGELOG, docs.

**Acceptance criteria:**
- [ ] `CHANGELOG.md` entry under `## Unreleased` describes: curator decouples from sessions, schema break in curation-store, default disabled-by-default cadence.
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm smoke` all green.
- [ ] No new `rg "session"` hits in `packages/core/src/curator-*.ts`.
- [ ] Branch pushed, PR opened against `main`, awaiting review.

**Verification:** CI green on PR; manual review.

### PR 0 verification gate

- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm smoke` all green.
- [ ] Curator pipeline references zero session symbols.
- [ ] Sessions table and tools untouched (this PR does NOT break sessions).
- [ ] Curator is disabled by default; existing operators see no autonomous curator activity.

### PR 0 risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Curator tests have deep session fixtures; replacement memory fixtures hard to write | M | M | Read each failing test individually; replace fixtures minimally |
| SQLite `ALTER TABLE DROP COLUMN` requires SQLite ≥3.35 | L | M | Check node-sqlite/better-sqlite3 version in package.json; fall back to table-rebuild migration if needed |
| Legacy config files in operator data dirs still set `min_sessions_since_run` | L | L | Log a notice; ignore gracefully |

---

## PR 1 — Add handoffs surface (additive)

**Branch:** `feat/sessions-rethink-pr1-handoffs-surface`
**Repo:** `the-librarian`
**Scope:** New MCP tools, store, CLI verbs, dashboard pages, slash commands. **No removals.** Old session surface continues to work in parallel.
**Dependencies:** PR 0 merged.

### Tasks

#### Task 1.1: Add handoff schema (S)

**Description:** Zod schema for handoff input/output + types. Anchored heading validation per spec §6.1.

**Acceptance criteria:**
- [ ] `packages/core/src/schemas/handoff.ts` exports `StoreHandoffInput`, `StoreHandoffOutput`, `ListHandoffsInput`, `ListHandoffsOutput`, `ClaimHandoffInput`, `ClaimHandoffOutput` Zod schemas.
- [ ] `StoreHandoffInput`'s `document_md` refinement asserts all five headings via anchored multiline regex (`/^## (Start & intent|Journey|Current state|What's left|Open questions)\b/m` — verify each must match independently).
- [ ] Length bounds: `title` 5..120 chars, `document_md` 100..50000 chars, `tags` ≤10 items.
- [ ] Schemas registered in `packages/core/src/schemas/index.ts` barrel.

**Verification:**
- `packages/core/src/schemas/handoff.test.ts` covers: valid input passes, missing heading fails, length-out-of-bounds fails, too many tags fails.
- `pnpm --filter @librarian/core typecheck` clean.

**Files:** `packages/core/src/schemas/handoff.ts` (new), `packages/core/src/schemas/handoff.test.ts` (new), `packages/core/src/schemas/index.ts` (modify).

#### Task 1.2: Add handoff store (M)

**Description:** CRUD operations + atomic claim, per spec §6.2.

**Acceptance criteria:**
- [ ] `packages/core/src/store/handoff-store.ts` exports `storeHandoff`, `listHandoffs`, `claimHandoff` (plus internal `purgeHandoff` for admin/test).
- [ ] IDs generated via `makeId("hdo")`.
- [ ] `claimHandoff` wraps the UPDATE + follow-up SELECT in a single `BEGIN IMMEDIATE` transaction.
- [ ] `listHandoffs` server-scopes by domain (read from auth context); user filters by `project_key` + `cwd` when both present.
- [ ] Exported from `packages/core/src/store/index.ts` barrel.

**Verification:**
- `packages/core/src/store/handoff-store.test.ts` covers: store → list (sees it) → claim → list (doesn't see it) → claim again (409); domain isolation; project+cwd filtering; concurrent claim (parallel claims; one 409); 404 on missing id.
- `pnpm test` green.

**Files:** `packages/core/src/store/handoff-store.ts` (new), `packages/core/src/store/handoff-store.test.ts` (new), `packages/core/src/store/index.ts` (modify).

#### Task 1.3: Add `handoffs` table to projection (S)

**Description:** Extend `initSchema` in `projection.ts` with the handoffs CREATE TABLE; bump `PROJECTION_SCHEMA_VERSION`.

**Acceptance criteria:**
- [ ] `PROJECTION_SCHEMA_VERSION` bumped from 16 to 17 in `packages/core/src/store/projection.ts`.
- [ ] `initSchema` includes the handoffs CREATE TABLE + the partial index per spec §6.2.
- [ ] No DROP of session tables yet (PR 7's job).
- [ ] On a fresh DB, the schema applies cleanly; on an existing DB at v16, the rebuild path runs and the new table appears.

**Verification:**
- Wipe local dev DB, restart MCP server, observe `handoffs` table created (via `sqlite3` CLI).
- With existing dev DB, restart, observe rebuild + handoffs table.
- `pnpm test` green.

**Files:** `packages/core/src/store/projection.ts`.

#### Task 1.4: Add three MCP tools (M)

**Description:** `store_handoff`, `list_handoffs`, `claim_handoff` tools at the MCP boundary.

**Acceptance criteria:**
- [ ] `packages/mcp-server/src/mcp/tools/store-handoff.ts`, `list-handoffs.ts`, `claim-handoff.ts` follow existing tool pattern.
- [ ] Tools registered in `packages/mcp-server/src/mcp/tools/index.ts` barrel.
- [ ] Error envelopes for 404 / 409 match existing convention.
- [ ] Domain resolution uses `packages/mcp-server/src/mcp/domain-resolution.ts`.

**Verification:**
- `packages/mcp-server/tests/mcp/handoffs.mcp.test.ts` covers the full round-trip + error cases per spec §7.
- `pnpm test` green.

**Files:** Three new tool files, `tools/index.ts` (modify), one new test file.

#### Task 1.5: Add CLI handoffs verbs (M)

**Description:** `the-librarian handoffs list|show|purge` subcommands.

**Acceptance criteria:**
- [ ] Three new top-level files in `packages/cli/src/commands/`: `handoffs-list.ts`, `handoffs-show.ts`, `handoffs-purge.ts`.
- [ ] `commands/index.ts` exports a new `handoffVerbs: Record<string, Command>` map (parallel to existing `sessionVerbs`).
- [ ] `runtime.ts` adds a `handoffs` dispatcher mirroring the `sessions` dispatcher.
- [ ] `handoffs purge` requires admin auth (mirror existing admin verb behaviour).

**Verification:**
- `pnpm --filter @librarian/cli build` then run `the-librarian handoffs list` against a local instance — returns empty list initially.
- CLI integration test (if pattern exists) covers list/show/purge.

**Files:** Three new CLI command files, `commands/index.ts` (modify), `runtime.ts` (modify).

#### Task 1.6: Add dashboard handoffs surface (M)

**Description:** Read-only list + detail pages, with tRPC router.

**Acceptance criteria:**
- [ ] `packages/mcp-server/src/trpc/handoffs.ts` exposes `list`, `byId` queries (read-only).
- [ ] `trpc/router.ts` registers the new router (`handoffs: handoffsRouter`).
- [ ] `apps/dashboard/app/handoffs/page.tsx` — list view: unclaimed by default, toggle for claimed, project filter.
- [ ] `apps/dashboard/app/handoffs/[id]/page.tsx` — detail view: rendered markdown of `document_md`, metadata sidebar, claim status.
- [ ] No claim button (claim is agent-only via MCP).
- [ ] Dashboard auth: `purge` admin-gated; list/detail follow same auth as memories list.

**Verification:**
- `pnpm dashboard` starts; navigate to `/handoffs` — page renders.
- `apps/dashboard/tests/components/handoffs.test.tsx` covers list rendering with empty + non-empty data and detail rendering.
- `pnpm test` green.

**Files:** `packages/mcp-server/src/trpc/handoffs.ts` (new), `trpc/router.ts` (modify), `apps/dashboard/app/handoffs/page.tsx` (new), `apps/dashboard/app/handoffs/[id]/page.tsx` (new), `apps/dashboard/tests/components/handoffs.test.tsx` (new).

#### Task 1.7: Add four slash commands (S)

**Description:** `.claude/commands/{handoff,takeover,learn,toggle-private}.md` per spec §6.5.

**Acceptance criteria:**
- [ ] Each command has frontmatter (description, allowed-tools or similar per existing pattern in `lib-session-*.md`).
- [ ] Body specifies the agent flow per §6.5 (contract level — not prescriptive wording).
- [ ] Old `lib-session-*` commands NOT touched yet (PR 7's job).

**Verification:** Open each command in Claude Code; confirm it appears in the slash menu.

**Files:** Four new files in `.claude/commands/`.

#### Task 1.8: Update healthcheck allow-list to include new tools (XS)

**Description:** `scripts/healthcheck.js` has an allow-list of expected MCP tools. Add the three new handoff tools to it. Do NOT remove session tools yet.

**Acceptance criteria:**
- [ ] `scripts/healthcheck.js` includes `store_handoff`, `list_handoffs`, `claim_handoff` in the expected surface.
- [ ] Existing 13 session tools still in the allow-list.

**Verification:** `pnpm healthcheck` green.

**Files:** `scripts/healthcheck.js`.

#### Task 1.9: PR finalisation (S)

**Description:** Smoke test, CHANGELOG, docs.

**Acceptance criteria:**
- [ ] `pnpm smoke` extended (or new step added) to round-trip `store_handoff` → `list_handoffs` → `claim_handoff`.
- [ ] `CHANGELOG.md` entry: "Added handoffs surface (additive). Old session surface unchanged; will be removed in PR 7."
- [ ] `test/baseline.json` updated for new tests.
- [ ] PR opened against `main`.

**Verification:** CI green.

### PR 1 verification gate

- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm smoke` all green.
- [ ] New handoffs round-trip works end-to-end.
- [ ] Old session surface still works (sanity check — run any session-related test).
- [ ] Dashboard `/handoffs` renders alongside existing `/sessions`.

### PR 1 risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `PROJECTION_SCHEMA_VERSION` bump triggers full rebuild on existing dev DBs | H | L | Expected behaviour; document in PR description |
| Domain resolution in `list_handoffs` differs from memory pattern | M | L | Read `domain-resolution.ts` and mirror exactly |
| Heading regex too strict / too lax | M | M | Test both negative and positive cases explicitly |
| Dashboard tRPC client setup differs from expected | M | M | Read existing `keyboard-host.tsx` and memory pages first |

---

## Inter-PR step: Deploy PR 1 to dev

After PR 1 merges, the operator (Jim) must deploy the monorepo to dev so the new MCP tools are reachable at runtime. Without this, the plugin PRs (2–6) will have nothing to test against.

This is a **manual step** outside the autonomous flow. The agent stops after PR 1 merges and waits for Jim's signal to proceed.

---

## PR 2 — Claude plugin migration

**Branch:** `feat/sessions-rethink-pr2-claude-plugin`
**Repo:** `the-librarian-claude-plugin`
**Scope:** Remove all session hook code; add four new slash commands. Plugin continues to function (memory tools, recall, etc. unchanged).
**Dependencies:** PR 1 deployed to dev.

### Tasks

#### Task 2.1: Add four new slash commands (S)

**Description:** Create `commands/{handoff,takeover,learn,toggle-private}.md` per spec §6.5.

**Acceptance criteria:**
- [ ] Four new command files with frontmatter matching existing convention (read `commands/lib-session-start.md` first).
- [ ] Each body follows §6.5 contract.
- [ ] Smoke test (`npm run smoke`) doesn't regress.

**Files:** Four new files in `commands/`.

#### Task 2.2: Delete session hook code (M)

**Description:** Remove `src/bin/claude-code-hook.ts`, `src/session.ts`, `src/privacy.ts`. Strip session bits from `src/harness/claude-code.ts`, `src/cli.ts`, `src/remote-cli.ts`, `src/state.ts`, `src/index.ts`.

**Acceptance criteria:**
- [ ] `rg "session" src/ -g '!*.md'` returns zero or only intentional refs (e.g. doc strings that mention the change).
- [ ] `rg "private" src/ -g '!*.md'` — natural-language private code (`/private`, `/public`, off-record detection) is gone; only the new in-conversation marker convention remains.
- [ ] `hooks/hooks.json` no longer registers session-related hook entries (UserPromptSubmit, PostCompact, TaskCompleted, SessionEnd). If the file becomes empty, delete it.
- [ ] `bin/librarian-claude-hook.js` deleted (or stub kept if other tooling references the path — verify).
- [ ] `npm run typecheck` clean.

**Verification:**
- `npm run typecheck && npm run build && npm run validate && npm run smoke` all green.

**Files:** Multiple in `src/`, `hooks/hooks.json`, `bin/`.

#### Task 2.3: Delete old slash commands (XS)

**Description:** Remove `commands/lib-session-*.md` (seven files) and `commands/lib-toggle-private.md`.

**Acceptance criteria:**
- [ ] All eight files deleted.
- [ ] `commands/` contains only the four new files plus any non-session commands (memory recall, etc.).

**Files:** Eight command markdown files (delete).

#### Task 2.4: Update SKILL doc + README (S)

**Description:** `skills/use-the-librarian/SKILL.md` describes the old 13-tool surface. Rewrite for the new surface. Update README and AGENTS.md sections.

**Acceptance criteria:**
- [ ] `SKILL.md` reflects four-verb command surface.
- [ ] README session-related sections updated.
- [ ] `CHANGELOG.md` entry describing the breaking change.

**Files:** `skills/use-the-librarian/SKILL.md`, `README.md`, `AGENTS.md`, `CHANGELOG.md`.

### PR 2 verification gate

- [ ] `npm run typecheck && npm run build && npm run validate && npm run smoke` green.
- [ ] Manual: install plugin, invoke `/handoff`, `/takeover`, `/learn`, `/toggle-private` against dev; each calls the expected MCP tool.
- [ ] Manual: confirm no session-related hook fires on prompt submit / compact / task complete.

### PR 2 risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `state.ts` has non-session state we shouldn't delete | M | M | Read the file; preserve any non-session keys |
| Compiled bundle `bin/librarian-claude-hook.js` is referenced elsewhere | L | M | Search for any references before deleting |
| SKILL.md is auto-loaded; bad rewrite breaks plugin install | M | M | Validate file syntax with `npm run validate` |

---

## PR 3 — Codex plugin migration

**Branch:** `feat/sessions-rethink-pr3-codex-plugin`
**Repo:** `the-librarian-codex-plugin`
**Scope:** Mirror of PR 2 for Codex.
**Dependencies:** PR 1 deployed to dev.

### Tasks

#### Task 3.1: Add four new slash commands (S)
- [ ] `commands/{handoff,takeover,learn,toggle-private}.md` matching Codex command convention.

#### Task 3.2: Delete session handlers (M)
- [ ] Delete `src/handlers/post-compact.mjs`, `checkpoint-policy.mjs`, `user-prompt-submit.mjs`, `session-bootstrap.mjs`, `session-start.mjs`, `stop.mjs`.
- [ ] Collapse `src/dispatch.mjs` to bootstrap-only or delete entirely.
- [ ] Delete `src/state-store.mjs`.
- [ ] Delete `bin/librarian-codex-hook.js` (compiled bundle); rebuild from cleaned source if smoke needs it.
- [ ] `hooks/` entries cleaned; delete directory if empty.

#### Task 3.3: Delete old slash commands (XS)

#### Task 3.4: Update SKILL + README (S)
- [ ] `skills/librarian/SKILL.md` rewritten.

### PR 3 verification gate
- [ ] Plugin smoke test green.
- [ ] Manual: invoke each command against dev.

---

## PR 4 — OpenCode plugin migration

**Branch:** `feat/sessions-rethink-pr4-opencode-plugin`
**Repo:** `the-librarian-opencode-plugin`
**Scope:** Mirror of PR 2 for OpenCode. Note: this plugin has the heaviest hook surface (per-turn capture) so deletions are larger.
**Dependencies:** PR 1 deployed to dev.

### Tasks

#### Task 4.1: Add four new slash commands (S)
- [ ] `commands/{handoff,takeover,learn,toggle-private}.md` matching OpenCode convention.

#### Task 4.2: Delete session handlers (M)
- [ ] Delete `src/handlers/chat-message.ts`, `session-idle.ts`, `session-compacted.ts`, `checkpoint-policy.ts`, `session-bootstrap.ts`, `session-created.ts`, `system-transform.ts`.
- [ ] Verify `src/handlers/ensure-commands.ts` scope; keep if it bootstraps the new commands, delete if it's session-only.
- [ ] Delete `src/state-store.ts`, `src/privacy-detector.ts`.
- [ ] Collapse `src/index.ts` event handler to a minimal bootstrap.

#### Task 4.3: Delete old slash commands (XS)

#### Task 4.4: Update README + CHANGELOG (S)

### PR 4 verification gate
- [ ] `bun test && bun run validate && bun run smoke` green.
- [ ] Manual: invoke each command against dev; per-turn events no longer recorded.

---

## PR 5 — Hermes plugin migration

**Branch:** `feat/sessions-rethink-pr5-hermes-plugin`
**Repo:** `the-librarian-hermes-plugin`
**Scope:** Python plugin; smaller surface.
**Dependencies:** PR 1 deployed to dev.

### Tasks

#### Task 5.1: Add four new commands to `commands.py` (M)
- [ ] Add four new subcommand registrations.
- [ ] Each command implementation calls the appropriate MCP tool via `client.py`.

#### Task 5.2: Remove session surface (M)
- [ ] Delete `state.py` entirely.
- [ ] Delete `privacy_gate.py` and `privacy.py`.
- [ ] Strip session subcommand registrations from `commands.py`.
- [ ] Strip session-tool methods from `client.py`.
- [ ] Strip `start_new_session()` and session tool plumbing from `provider.py`.

#### Task 5.3: Update README + CHANGELOG (S)
- [ ] Slash-commands table rewritten.

### PR 5 verification gate
- [ ] `pytest` green.
- [ ] Manual: invoke each command via Hermes against dev.

---

## PR 6 — Pi extension migration

**Branch:** `feat/sessions-rethink-pr6-pi-extension`
**Repo:** `the-librarian-pi-extension`
**Scope:** Pi-specific cleanup. Pi is in-process; the session client is direct.
**Dependencies:** PR 1 deployed to dev.

### Tasks

#### Task 6.1: Check Pi command surface (XS)
- [ ] Read `extensions/librarian/commands.ts` and Pi's command-registration spec.
- [ ] Decide whether the four new verbs surface as user-typed commands or as agent-only API calls.

#### Task 6.2: Add four new commands (S)
- [ ] Add `handoff`, `takeover`, `learn`, `toggle-private` to `commands.ts`.
- [ ] Each invokes the appropriate MCP tool.

#### Task 6.3: Remove session surface (M)
- [ ] Delete `session-client.ts`.
- [ ] Delete `lifecycle/privacy.ts` (private mode is now in-conversation-only).
- [ ] Strip from `index.ts`: `createSessionClient`, the seven `lib-session-*` command registrations, `pi.on("session_compact"/"session_shutdown"/"session_start")` event wiring.
- [ ] Strip `harnessSessionKey` and `CaptureMode` import from `config.ts`.
- [ ] Strip session-id rendering from `conv-state-render.ts`.
- [ ] Strip session imports/orchestration from `orchestrator.ts` and `memory-tools.ts`.
- [ ] Strip off-record session comment + session-key construction from `handlers/system-prompt-augment.ts`.

#### Task 6.4: Update README + CHANGELOG (S)

### PR 6 verification gate
- [ ] Repo-native checks pass.
- [ ] Manual: invoke each command via Pi against dev.

### PR 6 risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Pi orchestrator has session deps that aren't obvious from grep | M | M | Read orchestrator end-to-end before deleting |
| In-process session client is referenced by other extension code | L | M | Check `index.ts` exports; verify no external consumers |

---

## PR 7 — Monorepo cleanup (destructive)

**Branch:** `feat/sessions-rethink-pr7-monorepo-cleanup`
**Repo:** `the-librarian`
**Scope:** Remove the 13 MCP tools, drop session tables, delete dashboard sessions surface, delete CLI sessions verbs, delete scripts/docs.
**Dependencies:** PR 1 + PR 2–6 all merged AND deployed.

### Tasks

#### Task 7.1: Delete 13 MCP session tools (M)
- [ ] Delete files `packages/mcp-server/src/mcp/tools/{start,get,list,record,checkpoint,pause,end,attach,continue,search,list-session-events,promote,purge}-session*.ts`.
- [ ] Remove imports from `tools/index.ts`.
- [ ] Delete `packages/mcp-server/tests/mcp/sessions.mcp.test.ts`.
- [ ] Update `recall-domain.mcp.test.ts` and `remember-domain.mcp.test.ts` to remove session-touching cases.

**Verification:** `pnpm --filter @librarian/mcp-server typecheck` clean; `pnpm test` green.

#### Task 7.2: Delete session store + projection rewrite (L)
- [ ] Delete `packages/core/src/store/session-store.ts` + tests.
- [ ] Rewrite `packages/core/src/store/projection.ts` to memory-only (drop session CREATE TABLEs, session_events_fts, projection handlers, DELETEs).
- [ ] Bump `PROJECTION_SCHEMA_VERSION` from 17 to 18.
- [ ] Add DROP IF EXISTS statements for `sessions`, `session_events`, `session_state_changes`, `session_events_fts` (and shadow tables) inside the existing migration transaction.
- [ ] Update `librarian-store.ts`: remove `sessionsPath`, `sessionsLegacyPath`, `rebuildSessionIndex`, `readSessionEvents`.
- [ ] On-disk file rename: `session_events.jsonl` → `session_events.jsonl.predeprecation.bak` at boot if present.

**Verification:** Fresh DB boot creates only memory-related tables; existing DB at v17 triggers rebuild and the session tables disappear.

#### Task 7.3: Delete schemas + events (S)
- [ ] Delete `packages/core/src/schemas/session.ts`.
- [ ] Delete `packages/core/src/schemas/events.ts` (or strip session envelopes).
- [ ] Remove `SessionEventType` enum from `packages/core/src/schemas/common.ts`.
- [ ] Remove session re-exports from `schemas/index.ts`, `store/index.ts`, `packages/core/src/index.ts`.

#### Task 7.4: Delete tRPC sessions router + dashboard sessions surface (M)
- [ ] Delete `packages/mcp-server/src/trpc/sessions.ts`.
- [ ] Strip from `trpc/router.ts`: `sessionsRouter` import + `sessions: sessionsRouter` composition.
- [ ] Delete `apps/dashboard/app/sessions/` directory (page, detail, actions).
- [ ] Delete `apps/dashboard/components/sessions/` directory (7 component files).
- [ ] Delete `apps/dashboard/e2e/sessions.spec.ts`.
- [ ] Delete `apps/dashboard/tests/components/lifecycle-actions.test.tsx`.
- [ ] Update `components/site-nav.tsx`: nav entry `/sessions` → `/handoffs`.
- [ ] Update `components/keyboard-host.tsx`: remove `trpc.sessions.list` query, `nav-sessions` target; repoint `"s"` keybinding to `/handoffs`.
- [ ] Update `components/ui-v2/command-palette.tsx`: placeholder text/comments.
- [ ] Update `app/layout.tsx`: page description.
- [ ] Update `tests/components/site-nav.test.tsx`, `tests/components/keyboard-host.test.tsx`.

**Verification:** `pnpm --filter @librarian/dashboard build` green; manual: dashboard loads, `/sessions` returns 404, `/handoffs` works.

#### Task 7.5: Delete CLI session verbs (M)
- [ ] Delete top-level files: `packages/cli/src/commands/{start,attach,checkpoint,continue,end,events,pause,search,show,list,_conv-id,_shared}.ts`.
- [ ] Remove `sessionVerbs` map from `commands/index.ts`.
- [ ] Remove `sessions` dispatcher from `runtime.ts`.
- [ ] Delete `.claude/commands/lib-session-{start,resume,list,checkpoint,pause,end,search}.md`.
- [ ] Delete `.claude/commands/lib-toggle-private.md`.

**Verification:** `the-librarian sessions list` returns "unknown subcommand"; `the-librarian handoffs list` still works.

#### Task 7.6: Delete formatters + curator-evidence test stub (S)
- [ ] Delete `packages/core/src/formatters/prose.ts` (handover prose formatter; only session consumer).
- [ ] Remove `formatSessionDetail`, `formatSessionEvents` from `packages/mcp-server/src/mcp/formatters.ts`.
- [ ] Remove their re-exports from `packages/mcp-server/src/index.ts`.
- [ ] Delete `packages/core/src/caller-backfill.ts` if entirely session-coupled, or strip session-only paths.

#### Task 7.7: Delete scripts + obsolete migration (S)
- [ ] Delete `scripts/check-session-state-divergence.mjs`.
- [ ] Delete `scripts/migrate-sessions-to-authoritative-sqlite.mjs`.
- [ ] Delete `test/r2-sessions-migration.test.ts`.
- [ ] Update `scripts/healthcheck.js`: remove the `session: [...]` allow-list (13 tools).
- [ ] Update root `package.json`: remove `check:session-state-divergence` script.

#### Task 7.8: Backup/restore tolerance (S)
- [ ] Update `packages/core/src/backup/backup.ts`: stop archiving `session_events.jsonl` and `sessions.legacy.jsonl`.
- [ ] Update `packages/core/src/backup/restore.ts`: tolerate the absence of those files in old archives (log + continue).

#### Task 7.9: Docs cleanup (S)
- [ ] Rewrite `docs/slash-commands.md` for four-verb surface.
- [ ] Move/delete `docs/migration-sessions-storage.md`, `docs/specs/done/session-*.md`, `docs/specs/done/012-harness-commands-and-lifecycle-spec.md` (treat as historical; move to `docs/specs/archive/` or delete).
- [ ] Update root `README.md` and `AGENTS.md`.

#### Task 7.10: PR finalisation (S)
- [ ] `test/baseline.json` updated.
- [ ] `CHANGELOG.md` entry: "Removed session subsystem; sessions, session_events, session_state_changes tables dropped; 13 MCP tools removed; dashboard sessions surface removed."
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm smoke` all green.
- [ ] PR description includes operator drain instructions and backup-format-change notice.

### PR 7 verification gate

- [ ] `rg -i "session" packages/ apps/ scripts/ docs/ -g '!*.bak' -g '!CHANGELOG.md' -g '!*.predeprecation.*'` returns zero or only intentional-historical refs.
- [ ] Fresh boot creates only memory + handoffs tables.
- [ ] Existing boot drops session tables cleanly.
- [ ] Dashboard /sessions 404; /handoffs works.
- [ ] CLI `sessions` subcommand unknown; `handoffs` works.
- [ ] Healthcheck reports clean tool surface (3 handoffs + memory tools).
- [ ] All 5 plugin smokes (manual) green against deployed monorepo.

### PR 7 risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Projection rewrite breaks memory pathways | M | H | Delete-and-test incrementally; keep memory tests green at each step |
| Drop tables on operator dev DB loses session data | H | L | Already accepted per D10; warn in CHANGELOG |
| One of the plugin PRs reverted; PR 7 destroys tools that plugin still calls | L | H | Pre-merge: verify all 5 plugin PRs are on `main` and deployed |

---

## End-of-project verification

After PR 7 merges and deploys:

- [ ] All six repos pass their checks.
- [ ] End-to-end demo: `/handoff` in Claude → `/takeover` in OpenCode → document arrives in second agent. Capture as a brief release note.
- [ ] Both `sessions-rethink.md` and `029-sessions-rethink-spec.md` linked from the relevant CHANGELOG entries.
- [ ] Jim updates `~/.claude/CLAUDE.md` to drop the 13-tool session surface description and the `LIBRARIAN_SESSION_ID` env var note.

---

## Cross-PR risk register

| Risk | When it matters | Mitigation |
|---|---|---|
| Plugin PRs reference MCP tools that aren't deployed yet | Between PR 1 merge and Jim's manual deploy | Stop after PR 1; wait for Jim's go-ahead |
| PR 7 lands before all plugin PRs | If autonomous flow drifts | Hard pre-check in PR 7: verify all five plugin PRs merged before opening |
| Schema rebuild loses data unexpectedly | PR 1 + PR 7 | Document expected behaviour in PR descriptions; recommend dev DB wipe |
| Curator config migration confuses operators | PR 0 deploy | Boot-time log notice |
| Compaction-erases-marker privacy regression | Post-cutover | Documented limitation per spec §6.5 |
| CI baseline (test count) drifts across PRs | All PRs | Update `test/baseline.json` at end of each PR; verify `pnpm check:test-count` green |

---

## Open questions remaining (resolve per-PR)

These are intentionally deferred; each gets resolved by reading the relevant code at the start of its PR:

1. **PR 1.6 — Dashboard auth posture for `/handoffs`** — read existing memory pages first; match.
2. **PR 2 — `state.ts` non-session content** — keep what isn't session; only delete the file if entirely session-coupled.
3. **PR 4 — `ensure-commands.ts` scope** — verify whether it bootstraps the new commands or is session-only.
4. **PR 6 — Pi command surface (user-typed vs API)** — read `extensions/librarian/commands.ts` first.
5. **PR 0.5 — SQLite version for `ALTER TABLE … DROP COLUMN`** — verify in monorepo's SQLite driver version; fall back to table-rebuild migration if old.

---

## Stop conditions

The autonomous agent must halt and report (not push fixes) if:

- A verification gate fails and the cause is non-obvious after a single targeted attempt.
- A task acceptance criterion cannot be met (e.g. an `rg` reveals references the spec didn't anticipate).
- A schema change appears to require data loss beyond what D10 authorised.
- A PR diff exceeds ~50 files or ~3000 lines (sign that scope creep snuck in).
- Tests fail in a previously-passing area (regression — investigate before continuing).

Stopping is correct behaviour. The goal is mergeable PRs with clear scope, not unattended churn.
