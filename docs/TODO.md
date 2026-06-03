# TODO / deferred follow-ups

The project's single backlog of deferred, non-blocking work — surfaced during the
autonomous builds and from session/operator follow-ups. Each item is a focused
follow-up PR or chore. Grouped by theme, roughly highest-value first within each
group. Remove an item when its PR merges. (Completed specs are archived under
[`docs/specs/done/`](./specs/done/); resolved backlog items are dropped here rather
than struck — git history holds the record.)

## Security & hardening

- **`/healthz` info disclosure.** `GET /healthz` returns auth-posture booleans
  (`mcp_auth`, etc.) unauthenticated. Keep `{status:"ok"}` public; move the
  auth-posture fields behind admin auth. Touches the `/healthz` contract,
  `packages/mcp-server/tests/http/routes.test.ts`, and the healthcheck script.
  _(deploy review)_
- **Rate-limit the `/mcp` auth surface.** No throttling on bearer-token
  verification → online guessing isn't slowed. (The dashboard credentials route is
  rate-limited as of D3.2; `/mcp` bearer auth is not.) Add per-IP/token rate limiting
  in a focused hardening PR. _(A3 review)_
- **Master-key rotation (`the-librarian rekey`).** There is **no built-in way to
  change `LIBRARIAN_SECRET_KEY` / `secret.key`** today. `secret-crypto.ts` states
  rotation is a manual "decrypt-all + re-encrypt under the new key"; the `gcm1`
  payload format deliberately reserves room for a future `gcm2` (key-id envelope)
  for online rotation, but it's unbuilt. The only key-handling that exists is
  `restore --secret-key`, which *supplies an existing* key to a new host (verify +
  persist), not change it. **Suggestion:** a `rekey --old-key <k> --new-key <k>`
  CLI that walks every `is_secret=1` row in `settings`, `decryptSecret(old)` →
  `encryptSecret(new)`, writes them back, then swaps `secret.key` — guarded
  (`--force`, store-closed). **Warn loudly** that the dashboard JWT secret is
  HKDF-derived from the master key (`auth/auth-config.ts`: "rotating the master key
  rotates sessions"), so rotation invalidates all dashboard logins (re-login
  required); memories/sessions (plaintext) are unaffected. **Backup caveat to
  document either way:** existing backup bundles hold their `settings` secrets
  encrypted under the *old* key, so restoring an old bundle's credentials after a
  rotation needs the old key (memories/sessions restore fine). Touches
  `secret-crypto.ts`, `store/settings-store.ts`, `packages/cli`. _(spec 033 review;
  parked at owner's request — leave key-change out of 033)_

## Correctness & robustness

- **Restore cross-file atomicity.** `restoreBackup` is atomic per file (temp +
  rename) with an up-front checksum pass, and is idempotent on re-run, but a crash
  *between* files leaves a mixed data dir. Not done: full stage-into-temp-dir-then-
  swap + reconciling/removing data-dir files absent from the manifest (e.g. a
  lingering pre-R3 `sessions.jsonl`). _(B1 review)_
- **Enforce store-closed on CLI `restore`.** `restoreBackup` has no store handle,
  so it can't detect an open store. The CLI `restore` command MUST refuse (or
  close) when the store is open, to avoid restoring under a live connection.
  _(B1 review)_

## Testing

- **Enforcement-ON Playwright e2e.** Password sign-in + lockout
  (`e2e/auth-password.spec.ts`) and the setup wizard (`e2e/auth-setup.spec.ts`) are
  now e2e-covered via a globalSetup that configures auth methods with enforcement
  OFF. The remaining gap is the enforcement-ON unauth→`/login` redirect / fail-closed
  block — enabling enforcement on the shared webServer would redirect every other
  spec, so it needs a dedicated Playwright project + auth-enabled server. The decision
  logic is unit-tested (`tests/auth-gate`, `tests/trpc-proxy-gate`). _(A2 / D3 / D5)_
- **Two queued dashboard component tests** — `LifecycleActions` interaction +
  the `startTransition(async)` pending-state regression. Carved out of the dashboard
  redesign (D1.x) and still pending.

## Operator / verification chores

These are deployment-specific exercises against the canonical instance, not code.

- **Exercise the remaining `/lib-session-*` verbs end-to-end** (resume, checkpoint,
  pause, end with-and-without summary, search) to confirm Claude Code dispatches each
  natively. `start` was verified.
- **Run the healthcheck against the deployed canonical instance** —
  `pnpm run healthcheck -- --remote https://<canonical>:3838 --agent-token <token>`.
  Passes locally; needs a run against the production Librarian.
- **Configure `LIBRARIAN_AGENT_TOKENS` on the canonical server** so Claude Code
  session calls attribute to a real `agent_id` (today they record as
  `unknown-agent`). With dashboard-managed tokens (A5) you can mint these from the
  **Tokens** UI instead of env.
- **Validate the Hermes plugin's privacy gate end-to-end.** Round-trip
  (recall/remember/verify) was confirmed on the VPS, but the
  `pre_gateway_dispatch` privacy gate wasn't exercised against a natural-language
  marker. Send a turn containing "off the record …" and confirm the next turn
  isn't recorded; toggle back via `/lib-toggle-private` and confirm recording
  resumes.

## Classifier — local mode lifecycle

- **Surface installed local models on the cockpit + let operators delete
  them.** `node-llama-cpp` caches downloaded GGUF files under its own
  models dir; today there's no surface in the dashboard showing which
  ones are present, how big they are, or which one the running worker
  is using, and no way to evict an unwanted one short of shelling into
  the container. Add a panel under `/classifier` that lists installed
  models (path, size, last-used, whether currently loaded) and an
  admin-only delete control. Probably wants a new tRPC procedure
  `classifierConfig.localModels` returning the list and a `deleteLocalModel`
  mutation, plus a `du`-style scan of the node-llama-cpp cache dir.
  Block: deleting the currently-loaded model needs to either refuse, or
  stop the worker first (probably the latter — feels right that the UI
  flow is "switch to a different model → restart → delete the old one").

## Dashboard / UI polish

Deliberate carve-outs from the dashboard redesign (D1.x) that needed a more careful
landing than the autonomous run had room for.

- **Inline KeyHint on every primary button.** The ⌘K palette + shortcuts overlay
  shipped; per-button KeyHints land alongside the full per-surface keyboard binding
  map (j/k navigation, `a` archive, `v` verify, …).
- **Licensed PP Editorial New + PP Neue Montreal fonts.** Currently the free
  fallback (Fraunces / Newsreader); swap-in is a one-liner once the licence is bought.
- **Full editorial table rewrite + three-tab view switcher + remaining filter
  dropdowns** (priority, date range, usefulness, has-duplicates) for Memories.
- **Editorial card stack for Sessions** — the next iteration past the data-driven
  dropdowns.

## Spec open questions (deferred)

- **Collapse `is_global` into `domain` by renaming `general` → `global`.**
  Drop the boolean entirely; let `domain="global"` carry "visible everywhere"
  and leave every other domain isolated. Easier to reason about (1D pick
  instead of a 2×2 truth table) and removes the existing trap where
  `domain="general" & is_global=false` is invisible from work-area domains
  despite "general" reading as "everywhere" to a human. Costs: lossy
  migration for the `domain=X & is_global=true` combo (proposal: copy the
  prior domain into an `origin-domain:<x>` tag), classifier output schema
  change (`is_global` boolean → `domain` string), and prompt/eval-fixture
  refresh. Pick up when operators repeatedly hit the
  `domain=general & is_global=false` trap, when classifier-eval shows low
  agreement on `is_global` verdicts, or when a new feature would compound
  the two-axis complexity rather than collapse it.
  _(raised 2026-05-29; parked pending real-usage evidence)_
- **`harness_private` visibility.** Add later if sandbox/test traffic patterns
  demand it.
- **Physical purge of soft-deleted sessions** — retention policy + admin UI (the
  `purge_session` admin tool exists; this is the policy/UI layer on top).
- **`session.split` / `session.merged` event types.** Revisit once usage patterns
  emerge.

## Harness integration ideas

- **Auto-manage Librarian sessions via Claude Code lifecycle hooks.** Investigate
  whether Claude Code's hook surface can drive the Librarian lifecycle without the
  user typing `/lib-session-*` verbs manually:
  - **`SessionEnd` → auto-pause** the attached Librarian session, but only when the
    user resumed/attached one this conversation (the resume skill keeps the
    `session_id` in conversational state — the hook reads that).
  - **`PostCompact` → auto-checkpoint** with the rolling summary so compacted-away
    context lands in the ledger first. Likely the highest-value hook (compaction is
    where session evidence is most at risk).
  - **`TaskCompleted` (or equivalent) → auto-checkpoint** at a finer grain. Lower
    priority — risk of a noisy ledger; might gate on "task touched ≥ N files".
  - Open questions: how to thread the resumed `session_id` into the hook process
    (env var? side-channel file?); whether to suppress hook-driven calls right after
    an agent-side checkpoint; whether other harnesses (Hermes, OpenCode) have
    analogous lifecycle events worth wiring the same way.
- **Hermes per-verb commands.** Pending whether Hermes supports per-command
  registration with autocomplete. If it does, port the per-verb pattern; if not, stay
  with single-command-plus-parse and update the package docs.
- **Codex slash surface (shelved).** Codex CLI has no user-invokable slash-command
  primitive. Options: a single `lib-session` skill priming the verb surface, a
  `UserPromptSubmit` hook intercepting `/lib-session-*`, or waiting for native
  commands.
- **Pi runtime (shelved).** Revisit once Pi's interface is defined.

## Deploy & ops

- **Verify `fly.toml` against the current Fly schema.** It's a starter template;
  the schema (`auto_stop_machines` value type, `[mounts]` form,
  `[[services]]`/`[http_service]`) was not live-verified — see the header note in
  `fly.toml` and DEPLOYMENT.md. The host-agnostic `docker run` one-liner is the
  primary path.

## Dependencies

- **Bump `next` / `postcss`.** A moderate advisory (GHSA-qx2v-qp2m-jg93) sits in
  the lockfile via `next` (build-time CSS tooling, not a runtime input path — not a
  regression). Worth a repo-wide bump in its own change. _(A1)_

## Auth enhancements (optional)

- **GitHub verified-email allowlisting.** The email allowlist
  (`LIBRARIAN_OWNER_EMAILS`) is honored only for provider-verified emails; GitHub
  carries no `email_verified`, so it's effectively Google-only and GitHub owners
  must use the GitHub account id. If GitHub email allowlisting is wanted, fetch
  verified emails from `GET /user/emails` (extra scope + API call). Skipped for
  single-owner where the account id is the robust key. _(A1)_
- **Full browser-based MCP OAuth** remains explicitly out of scope (see
  [`docs/specs/done/017-single-owner-auth.md`](./specs/done/single-owner-auth.md)) —
  revisit via a managed provider only when there are non-technical users or many
  clients.

## Cross-repo: `the-librarian-claude-plugin`

The sibling plugin repo (`JimJafar/the-librarian-claude-plugin`) bundles
`@librarian/lifecycle` as a committed esbuild artifact — a coupling invisible from
this repo.

- **Regenerate the plugin bundle after any `@librarian/lifecycle` change.**
  `npm run build` in the plugin repo (needs a sibling `the-librarian` checkout or
  `LIBRARIAN_MONOREPO`), then commit — its CI has a `PROVENANCE.json` hash
  drift-guard that fails on a stale bundle.
- **Flip the plugin repo to PUBLIC** before distributing via the marketplace
  (currently private).
- **Codex plugin.** The codex adapter has remote-transport support but no
  distributable plugin yet (test-only) — a codex plugin could follow the Claude
  plugin's shape.

## Features / functional improvements

- **Curator retrospective refactoring / re-organisation (later phase).** Today the
  consolidator only acts on INCOMING submissions — one judgment (create / augment /
  supersede / archive) against one target. It never revisits existing nodes to
  reorganise them. A later phase: a periodic grooming pass that reasons over the
  whole graph and refactors it — **split** a node that has accreted several entities
  into a hub + spokes (e.g. a "Team" doc that collected per-person facts → a Team
  hub + a wikilinked node per member), **merge** near-duplicates, and **repair/add
  missing links**. Distinct from the per-submission judge (corpus-level, not one
  fact); gated behind git review so every refactor is a reviewable, revertable diff.
  _(design conversation 2026-06-03; spec 039's per-submission entity-granularity
  guidance reduces — but doesn't remove — the need for this, since the judge can't
  retro-fix nodes that already grew too coarse)_
- Look at offering a tiny local LLM as an alternative to cloud / API LLM for the
  memory consolidator (see https://github.com/tgrytnes/mnemosyne).
- Improve memory storage & retrieval with polyphonic recall (see
  https://github.com/tgrytnes/mnemosyne).
- **`remember` should return the new memory id** (and `propose_memory` the new
  proposal id) so a write → verify chain is one round-trip instead of two. Today
  the agent has to call `recall include_ids:true` after a `remember` to discover
  the id, which is wasteful. Surface it in the result text (e.g. "Memory stored
  ([mem_…])") so the existing `content[0].text` channel carries it.
