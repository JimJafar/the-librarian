# The Librarian — Outstanding work

Snapshot taken 2026-05-21 after closing out the maintainability overhaul (all 30 task PRs landed; `specs/done/maintainability-overhaul-*.md` now read "Implemented"). Items here are the leftovers — verbs still to exercise, the per-agent token wiring, polish, and deferred cross-harness work.

## Open from sessions / operator follow-ups

1. **Exercise the remaining `/lib-session-*` verbs end-to-end** (resume, checkpoint, pause, end with-and-without summary, search) to confirm Claude Code dispatches each natively. Start was verified. The retired verbs (archive/restore/delete/status) were dropped in S1.2.
2. **Run `pnpm run healthcheck -- --remote https://<canonical>:3838 --agent-token <token>` against the deployed canonical instance.** Passes locally — needs a run against the production Librarian to validate the actual deployment.
3. **Click through the Sessions dashboard tab in a real browser against a real dataset.** Server-side wiring is covered by tRPC integration tests, component tests, and Playwright e2e, but operator-style "is the surface usable" exercise is still pending. (Tied to #17 — likely subsumed by the redesign.)
4. **Configure `LIBRARIAN_AGENT_TOKENS` on the canonical server** so Claude Code session calls attribute to a real `agent_id`. Today they record as `unknown-agent` because no per-agent token is mapped for the Claude Code client.
5. **Decide whether to promote any of yesterday's decisions into durable memory.** My read so far is that none meet the bar (the substantive work is in git, the operational facts are observable from the dashboard), but worth a deliberate pass.

## Cross-harness follow-ups

6. **Hermes per-verb commands.** Pending Jim's answer on whether Hermes supports per-command registration with autocomplete. If it does, port the per-verb pattern; if not, stay with single-command-plus-parse and update the package docs accordingly.
7. **Codex slash surface (shelved).** Codex CLI has no user-invokable slash command primitive. Future call: ship a single `lib-session` skill that primes the agent on the verb surface, build a `UserPromptSubmit` hook that intercepts `/lib-session-*` and shells out, or wait for Codex to add native commands.
8. **Pi runtime (shelved).** Spec defers Pi's runtime as an open question. Revisit once Pi's interface is defined.

## Spec open questions (deferred)

9. **`harness_private` visibility.** Add later if sandbox/test traffic patterns demand it.
10. **Physical purge of soft-deleted sessions.** Retention policy + admin UI.
11. **`session.split` / `session.merged` event types.** Revisit once usage patterns emerge.

## Harness integration ideas

12. **Auto-manage Librarian sessions via Claude Code lifecycle hooks.** Investigate whether Claude Code's hook surface can drive the Librarian lifecycle without the user typing `/lib-session-*` verbs manually. Sketch:
    - **`SessionEnd` → auto-pause** the attached Librarian session, but only when the user had resumed/attached one in this conversation. The `/lib-session-resume` skill already keeps the resumed `session_id` in conversational state — the hook would read that to decide whether to fire.
    - **`PostCompact` → auto-checkpoint** with the rolling summary so the compacted-away context lands in the ledger before it's gone. Likely the highest-value hook of the three since compaction is exactly where session evidence is most at risk.
    - **`TaskCompleted` (or equivalent) → auto-checkpoint** at a finer grain. Lower priority — risk of noisy ledger if every micro-task fires a checkpoint; might gate on "task touched ≥ N files" or similar.
    - Open questions: how to thread the resumed `session_id` into the hook process (env var? side-channel file?); whether to suppress hook-driven calls when an agent-side checkpoint just ran; whether other harnesses (Hermes, OpenCode) have analogous lifecycle events worth wiring the same way.

## Architecture — revisit later

13. ~~**Re-evaluate JSONL append-only as the session-storage paradigm.**~~ Resolved 2026-05-21 across R1–R4 (PRs #64–#67). Sessions are now SQLite-canonical: state lives in the `sessions` row + the `session_state_changes` audit table; timeline events go to a new `session_events.jsonl`. The `purge_session` admin tool handles hard delete. Backup story is loud in the README. See `specs/done/session-storage-rearchitecture.md` for the full record.

## Dashboard / UI

14. **Generate auth tokens from the dashboard instead of static env vars.** Today admin + agent tokens are baked into `LIBRARIAN_ADMIN_TOKEN`, `LIBRARIAN_AGENT_TOKEN`, and `LIBRARIAN_AGENT_TOKENS` at boot — one admin token, no rotation without a restart, no per-token audit. Belongs in the dashboard rebuild scope (not a migration of the existing dashboard — see #15). Sketch:
    - **Token model:** name/description, role (`admin` / `agent`), bound `agent_id` for agent tokens, optional expiry, created_at, last_used_at, revoked_at. Persisted to the JSONL ledger as `auth.token_issued` / `auth.token_revoked` events so the audit trail comes for free.
    - **Bootstrap:** on first boot with no tokens recorded, generate a single one-shot admin token and print it once to stderr (or a write-protected file) so the operator can sign in. After that, all token management happens through the dashboard.
    - **Dashboard surface:** "Tokens" panel under settings — list active tokens with last-used + role, "Generate" button (dropdown for role + agent_id when role=agent), "Revoke" action. Prefer dropdowns for known-value fields (role, agent_id) per the global UI feedback.
    - **Server side:** auth middleware (T4.1's `authenticateMcp`) consults the token table instead of comparing against env-var constants. Env vars can still seed the table on first boot for backwards compatibility, then become advisory.
    - **Pairs with:** #4 (per-agent tokens become trivial — admin can mint one per agent from the UI).

## Dashboard review follow-ups (2026-05-20)

The big-ticket items #15–#17 from the original snapshot landed across
D1.0–D1.5 (PRs #52–#57). The follow-ups below are deliberate carve-outs
from those PRs that the spec called for but that needed a more careful
landing than the autonomous run had room for:

- **Delete `apps/dashboard/components/ui/`** (the legacy shadcn skin). The
  D1.0 plan put this in D1.5, but the actual deletion touches ~16 call
  sites across memories + sessions and would risk regressions; deferred
  to a focused refactor PR after the operator validates the surfaces.
- **Inline KeyHint on every primary button.** D1.4 shipped the cmd-K
  palette + shortcuts overlay; per-button KeyHints land alongside the
  full per-surface keyboard binding map (j/k navigation, `a` archive,
  `v` verify, …).
- **Licensed PP Editorial New + PP Neue Montreal fonts.** D1.0 uses the
  free fallback (Fraunces / Newsreader) per the spec's open question.
  Swap-in is a one-liner once the licence purchase is made.
- **Full editorial table rewrite + three-tab view switcher + remaining
  filter dropdowns** (priority, date range, usefulness, has-duplicates)
  for the Memories surface. D1.1 shipped the bulk re-home flow against
  the existing table; the editorial table is the next iteration.
- **Editorial card stack for Sessions.** D1.2 shipped the data-driven
  dropdowns; the card-stack rewrite is the next iteration.
- **The two queued component tests** (LifecycleActions interaction +
  `startTransition(async)` pending regression). Still pending.

## Resolved in the maintainability overhaul

These items appeared on earlier snapshots and have been closed naturally — recorded here for the next person reading old PRs or session ledgers.

- ~~**Memory simplification — too many states, missing consolidation flow, 82 outdated memories with no archive path.**~~ Resolved 2026-05-21 across V1.1–V1.4 (PRs #45–#48). State model collapsed to `active | proposed | archived`; `verify_memory` is now load-bearing (`outdated` archives, `useful`/`not_useful` move recall rank ±3); `delete_memory` renamed to `archive_memory`; conflict-detection machinery retired; `scripts/replay-verify-outcomes.mjs` backfills historical verdicts. See `specs/done/memory-simplification.md` for the full record.
- ~~**Session simplification — five session statuses (`active|paused|ended|archived|deleted`) and `/lib-session-archive` / `restore` / `delete` / `status` slash verbs.**~~ Resolved 2026-05-21 across S1.1–S1.3 (PRs #49, #50, this PR). State model collapsed to `active | paused | ended`; `end_session` covers archive/delete intents (summary now optional); `continue_session` covers restore (works on ended sessions, flipping them back to paused); `list_sessions` / `search_sessions` default to `active + paused` with `include_ended` opt-in (legacy `include_archived` / `include_deleted` accepted as aliases for one release). The four retired slash commands and `archive_session` / `restore_session` / `delete_session` MCP tools + tRPC procedures + CLI verbs are gone. See `specs/done/session-simplification.md` for the full record.
- ~~**Dashboard redesign — generic shadcn look, no bulk re-home flow, free-text filters where dropdowns would do, Recall buried under Memories→Logs, no command palette.**~~ Resolved 2026-05-21 across D1.0–D1.5 (PRs #52–#57). Editorial colour palette + free-fallback fonts via `next/font` (D1.0); seven `ui-v2/*` design-system stubs; bulk re-home modal with one-tRPC-round-trip + data-driven `agent_id` / `project_key` dropdowns (D1.1); sessions filter dropdowns on `current_harness` + `project_key` (D1.2); Recall promoted to a top-level surface with timeline + pinned memories + insights strip (D1.3); ⌘K command palette + `?` shortcuts overlay + `g m/s/r` nav (D1.4); docs polish (D1.5). See `specs/done/dashboard-redesign.md` for the full record + the follow-up carve-outs in the section above.
- ~~**Integration docs missing V1.x memory verb shape.**~~ Resolved 2026-05-21 in I1 (PR #60). Each of the five harness `AGENTS.md` / `CLAUDE.md` / `AGENTS.append.md` files now carries a Memory three-state paragraph + `verify_memory` post-recall guidance + an updated tool list. Healthcheck adds an "MCP tool surface" check that asserts the V1.x + S1.x contract at boot. See `specs/done/integration-docs-memory-verbs.md` for the full record.
- ~~**Dashboard runs on two parallel UI atom libraries.**~~ Resolved 2026-05-21 across U1–U3 (PRs #61–#63). Built editorial `ui-v2/dialog | input | table | tabs` atoms (U1); migrated Sessions surface off the legacy shadcn skin (U2); migrated Memories + Recall + theme-toggle, deleted `apps/dashboard/components/ui/` entirely (7 files), added an ESLint `no-restricted-imports` guard (U3). See `specs/done/ui-library-consolidation.md` for the full record.
- ~~**Session storage paradigm mismatch.**~~ Resolved 2026-05-21 across R1–R4 (PRs #64–#67). Sessions are SQLite-canonical post-R3: state lives in the `sessions` row + `session_state_changes` audit table; timeline events go to a new `session_events.jsonl`. New `purge_session` admin tool handles hard delete; one-shot migration script + CI divergence guard + operator runbook ship as tooling. README has a dedicated "Backup strategy" section because the three critical files (`events.jsonl` + `session_events.jsonl` + `librarian.sqlite`) now all need backup — SQLite is no longer rebuildable for sessions. See `specs/done/session-storage-rearchitecture.md` for the full record.
- ~~**Dashboard REST endpoints lack auth** (`issues/001-dashboard-rest-no-auth.md`).~~ Resolved 2026-05-20 in T7.1 — the legacy `/api/*` REST surface is deleted. The replacement admin API (`/trpc/*`) is admin-gated; the new Next.js dashboard injects the bearer server-side via its same-origin proxy + Server Actions, so the admin token never reaches the browser.
- ~~**Residual `/lib:session` references in `integrations/claude-code/`.**~~ Swept 2026-05-21 in T9.2. Abstract cross-harness contract references in `docs/slash-commands.md` are intentionally retained.
- ~~**One-Node-process Dockerfile / `compose.yaml`.**~~ Retired 2026-05-21 in T8.2. The new compose stack lives under `docker/` (`mcp-server.Dockerfile`, `dashboard.Dockerfile`, `docker-compose.yml`); see [`DEPLOYMENT.md`](./DEPLOYMENT.md).

## Priority read

- **#4** is the easiest operational win — once tokens are mapped, dashboard logs and session ownership checks become useful.
- **#15–#17** is the next substantive engineering block (the dashboard redesign + tests rebalance). Will likely subsume #3 and pair with #14.
- **#1, #2, #5** are operator/verification chores — small.
- Everything else is deferred / observational.
