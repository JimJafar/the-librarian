# The Librarian — Outstanding work

Snapshot taken 2026-05-18 after shipping Phases 1–6 of `specs/session-layer-and-harness-packages.md` (commits `0d7a329..42935b7`, all on `main`). Items reflect what was open at that point; check the active session's `next_steps` for fresher movement before relying on this list.

## Open from the active session

Active session at time of writing: `ses_e4e7fc21-0096-42b4-b091-5701c84539e5` ("Verifying /lib-session-* native commands").

1. **Exercise the remaining `/lib-session-*` verbs end-to-end** (resume, checkpoint, pause, archive, restore, delete, search) to confirm Claude Code dispatches each natively. Start was verified. Status was verified.
2. **Run `npm run healthcheck` against the deployed canonical instance.** It passes locally — needs a run against the production Librarian to validate the actual deployment.
3. **Click through the Sessions dashboard tab in a real browser.** Server-side wiring is covered by HTTP + curl smoke; visual layout and button handlers have never been exercised interactively.
4. **Configure `LIBRARIAN_AGENT_TOKENS` on the canonical server** so Claude Code session calls attribute to a real `agent_id`. Today they record as `unknown-agent` because no per-agent token is mapped for the Claude Code client.
5. **Decide whether to promote any of yesterday's decisions into durable memory.** My read so far is that none meet the bar (the substantive work is in git, the operational facts are observable from the dashboard), but worth a deliberate pass.

## Cross-harness follow-ups

6. **Hermes per-verb commands.** Pending Jim's answer on whether Hermes supports per-command registration with autocomplete. If it does, port the per-verb pattern; if not, stay with single-command-plus-parse and update the package docs accordingly.
7. **Codex slash surface (shelved).** Codex CLI has no user-invokable slash command primitive. Future call: ship a single `lib-session` skill that primes the agent on the verb surface, build a `UserPromptSubmit` hook that intercepts `/lib-session-*` and shells out, or wait for Codex to add native commands.
8. **Pi runtime (shelved).** Spec defers Pi's runtime as an open question. Revisit once Pi's interface is defined.

## Open repo issue

9. **`issues/001-dashboard-rest-no-auth.md` — REST endpoints lack authentication.** Discovered 2026-05-12 by Joseph. The `/api/*` routes on the dashboard have no auth gate while `/mcp` requires a Bearer token. The Phase 4.1 work I shipped (`/api/sessions/*`) extends this surface without fixing the underlying auth gap. Worth prioritising — this is the only outstanding item that's a real security risk rather than polish.

## Documentation cleanup

10. **Residual `/lib:session` references.** A few places still use the old `/lib:session <verb>` form where they should now use the per-verb name (`/lib-session-<verb>`). Confirmed offenders (run `rg "/lib:session"` to refresh):
    - `integrations/claude-code/CLAUDE.md` line 45 (`/lib:session resume <id>` → `/lib-session-resume <id>`) and line 57 (`/lib:session end`'s candidates → `/lib-session-end`'s candidate memories).
    - `integrations/claude-code/slash-commands.md` line 38 ("Hermes and OpenCode register a single `/lib:session` command…") — OpenCode is now per-verb too; that line needs to drop OpenCode and reference the canonical doc instead.
    - References that mention `/lib:session <verb>` as the **abstract cross-harness contract surface** are correct (e.g. `docs/slash-commands.md`, the "canonical contract" lines in each commands `.md`) and should stay.

## Spec open questions (deferred)

11. **`harness_private` visibility.** Add later if sandbox/test traffic patterns demand it.
12. **Physical purge of soft-deleted sessions.** Retention policy + admin UI.
13. **`session.split` / `session.merged` event types.** Revisit once usage patterns emerge.

## Priority read

- **#9 is the only real risk.** Everything else is polish or exercise.
- **#4** is the easiest win — once tokens are mapped, dashboard logs and session ownership checks become useful.
- **#2 and #3** are the spec checkpoints that were never formally closed.
- **#10** is small but worth knocking out next time anyone touches the integration packages.
- The rest can wait until the layer is next touched.
