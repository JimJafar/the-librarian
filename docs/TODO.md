# TODO / deferred follow-ups

The project's single backlog of deferred, non-blocking work — surfaced during the
autonomous builds and from session/operator follow-ups. Each item is a focused
follow-up PR or chore. Grouped by theme, roughly highest-value first within each
group. Remove an item when its PR merges. (Completed specs are archived under
[`docs/specs/done/`](./specs/done/); resolved backlog items are dropped here rather
than struck — git history holds the record.)

## ⭐ Next headline feature — a self-improving curator

Now a brainstorm: **[`docs/research/self-improving-curator-brainstorm.md`](research/self-improving-curator-brainstorm.md)**
— the resident curator learns this install's preferences by proposing eval-gated,
admin-approved edits to its own prompt addendum (never the safety core), from
structured operator feedback + an optional dashboard chat.

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
- **Memoize the curation-runs read within one grooming pass.** Plan-046 retired
  the per-slice interval gate, so a scheduled grooming pass now iterates **every**
  slice; each slice does ~2 full `readAll()` of `curation-runs.json` (the
  `findRunningRun` lock check + the `findCompletedApplyRun` idempotency check),
  i.e. ~2N whole-file reads/parses per pass even when nothing changed. LLM cost is
  correctly bounded (idempotency skips unchanged slices before any LLM call) — this
  is I/O amplification only, negligible at current scale (tens of slices) but
  grows with projects/agents. Fix: snapshot the **completed-runs** read once per
  `runDueCuration` pass for the idempotency check (safe — a serial pass only adds
  runs for *other* slices, different input hashes), leaving the cross-process lock
  read (`findRunningRun`) live. **Still deferred, kept low-priority.** The PR-2 rename has now
  merged and settled these files, so the original timing caveat is spent. What
  remains is the cost/benefit: the benefit is I/O-only (eliminating ~2N redundant
  whole-file reads/parses per pass) and negligible at current scale — tens of
  slices — though it grows with projects×agents; the cost is that the change
  touches lock/idempotency concurrency, so it warrants its own focused PR with a
  dedicated regression test (snapshot reused across slices within a pass; the
  cross-process lock read kept live) rather than being bundled into unrelated work.
  Pick it up when scale makes the I/O matter, or as a deliberate standalone change.
  _(plan 046 PR-1 review, finding #1)_

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

- **Validate the Hermes plugin's privacy gate end-to-end.** Round-trip
  (recall/remember/verify) was confirmed on the VPS, but the
  `pre_gateway_dispatch` privacy gate wasn't exercised against a natural-language
  marker. Send a turn containing "off the record …" and confirm the next turn
  isn't recorded; toggle back via `/lib-toggle-private` and confirm recording
  resumes.

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
- Add links to the GitHub and Google pages where users should register the OATH callbacks.

## Spec open questions (deferred)

- **`harness_private` visibility.** Add later if sandbox/test traffic patterns
  demand it.

## Harness integration ideas

Moved to a brainstorm: **[`docs/research/harness-driven-capture-brainstorm.md`](research/harness-driven-capture-brainstorm.md)**
— harness-driven raw-text capture (offload extraction to the server consolidator),
awareness injection at session-start / post-compaction, and lifecycle-boundary hooks
(the per-harness command-registration notes for Hermes/Codex/Pi are parked there too).

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
- **Better intake navigation via vault "maps" (parked — iterate later).** Today the
  consolidator's `navigate` step hands the judge ~K=8 recall candidates + a flat,
  title-only ToC, so finding the right place to file relies on semantic recall alone.
  Idea: auto-generate markdown "map of content" / hub notes that describe the vault's
  structure (frontmatter + wikilinks) so the LLM judge can navigate to the right
  neighbourhood structurally, not just by recall. Relatedly, a structured graph-query
  layer (Dataview-style queries over frontmatter + links — orphans, broken backlinks,
  overloaded nodes) would serve the grooming/refactor pass above. Connects to spec 039
  (hub-and-spoke). _(operator idea, 2026-06-05; ship current recall + 1-hop for now,
  revisit with the whole-graph grooming work)_
- Look at offering a tiny local LLM as an alternative to cloud / API LLM for the
  memory consolidator (see https://github.com/tgrytnes/mnemosyne).
- Improve memory storage & retrieval with polyphonic recall (see
  https://github.com/tgrytnes/mnemosyne).
- **`remember` should return the new memory id** (and `propose_memory` the new
  proposal id — note `propose_memory` was removed as an MCP tool in ADR 0006 /
  plan 048 PR-4; `remember` now subsumes it) so a write → verify chain is one
  round-trip instead of two. Today
  the agent has to call `recall include_ids:true` after a `remember` to discover
  the id, which is wasteful. Surface it in the result text (e.g. "Memory stored
  ([mem_…])") so the existing `content[0].text` channel carries it. NOTE: with
  intake enabled both verbs are now fire-and-forget into the inbox (ADR 0004 routed
  `propose_memory` there too), so there is **no synchronous memory/proposal id** on
  that path — the consolidator mints it on the next tick. This aspiration now holds
  only for the legacy (intake-off) direct write; the intake-on path would need a
  different handle (e.g. echo the inbox item id, or have the dashboard surface the
  resulting proposal).
- **~~Make references properly searchable (persist their embeddings).~~ DONE**
  (rethink T23/T24, 2026-06-12). Embeddings now persist in a sidecar cache at
  `<data-dir>/embeddings-cache/` (outside the vault), keyed by file path +
  content hash + embedder model id — a restart re-embeds nothing that hasn't
  changed (memories ride the same cache). References are chunked by
  heading/size (~6 KB chunks, 600-char overlap) and each chunk is indexed
  keyword+vector, so a 553 KB doc is searchable end-to-end; `search_references`
  returns the best chunk per file with its heading-breadcrumb anchor + char
  range (additive response fields). Remaining (cheap, not yet needed): the
  keyword/RRF index *structures* are still rebuilt per `search_references` call
  — only the embeddings (the expensive part) are cached. Add an in-memory index
  cache if reference search ever becomes hot.
  _(surfaced 2026-06-03 during the seed/migration work; closed by the rethink
  references phase)_

## References / recall follow-ups

Salvaged from the deleted `proposals/hybrid-recall.md` (the rest of that
proposal — FTS5/BM25 over a SQLite projection, JSONL-canonical boundaries —
was made obsolete by the markdown vault + hybrid keyword+vector RRF index):

- **Structured-signal ranker in hybrid recall**: fold metadata boosts
  (exact `project_key` match, priority band, confidence, usefulness) into
  the index-backed RRF path the way the keyword fallback already does, so
  the two paths rank consistently.
- **Recency/staleness weighting**: boost recently-useful memories;
  penalise stale ones beyond the existing flag soft-demote.
- **`explain` mode (admin/debug only)**: optional scoring breakdown on
  recall for the dashboard — normal agents keep clean prose, never ids +
  scoring internals.
- **Retrieval benchmark fixture**: a noisy-corpus fixture + benchmark
  (exact commands, filenames, project filtering, stale-memory penalties)
  so ranking changes are proven, not vibed. Pairs with the rethink's
  references chunking work (spec §9).
- **Date-range filters on recall** (`from`/`to`) for time-scoped queries.
