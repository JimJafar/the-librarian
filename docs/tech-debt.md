# Tech debt & deferred work

Consolidated **2026-06-05** from the local `AUTONOMOUS-BUILD-NOTES-*.md` scratch
files (gitignored) so every non-blocking follow-up flagged during the autonomous
builds lives in one reviewable, prioritisable place.

- **Scope:** code/maintenance debt only. Roadmap and feature ideas live in
  [`docs/TODO.md`](./TODO.md); this file is the "we shipped X but owe Y" list.
- **Priorities** (`High` / `Med` / `Low`) are a first-cut for triage — re-rank freely.
- **Line numbers** were accurate when flagged but earlier merges may have shifted
  them; re-grep the symbol before editing.
- Items here were **cut** from the source notes files (not copied); the notes
  retain their historical per-PR build logs and point here for follow-ups.

---

## Auth — dashboard-managed auth (build 2026-05-25)

- **[Low] `"15 minutes"` setup-link TTL is duplicated as a human string.**
  Hardcoded at `packages/cli/src/commands/auth.ts:50` and `:55` and again on the
  `/settings/auth/reset` page, while the real value lives in `SETUP_LINK_TTL_MS`
  (`auth.ts:34`). Derive the human string from the constant (or share a formatter)
  so they can't drift.
- **[Low] One-time admin-token bootstrap log interpolates the token into the
  message string** rather than a structured field (judged acceptable by review).
  Move it to a structured log field so it can't leak via string-formatted sinks.
- **[Low] `setEnabled(store, true)` stays exported but bypasses the `enableAuth`
  gate** — it's the ungated break-glass disable path (`enableAuth` is the gated ON
  path). By design; flagged so nobody "fixes" it by routing it through the gate.
  Worth a doc-comment reaffirming the intent if it isn't already explicit.
- **[Low] Restore master-key prompt reads with echo off.** Secure default; some
  operators paste long keys and want to see them. One-line flip if we decide
  paste-visibility beats shoulder-surfing resistance at restore time.
- **[Low] Restore opens a fresh store per key attempt** (re-runs migrations).
  Cheap at restore time; flagged only as a known inefficiency.

---

## Backup / restore — git-native backup (spec 040, builds 2026-06-04)

- **[Med] Vault git *history* is never scanned for secrets.**
  `scripts/check-no-secrets-in-vault.mjs:11` scans the vault working tree only, but
  the whole repo (including history) is what gets pushed — so a secret ever
  committed and later removed would persist in history and ship to the backup
  remote. Privacy is the product; a `git log -p` forensic scan is the heavier
  follow-up the script's own comment calls out.
- **[Low] `backup.github.repo` validation — env/read-path residual.** The tRPC write
  boundary now validates the `owner/repo` slug with a teaching error (PR #311). Residual:
  `resolveBackupRemote`/`resolveGithubSyncConfig` don't re-validate, so the
  `LIBRARIAN_BACKUP_GITHUB_REPO` env path and the read-time URL build stay unchecked —
  defense-in-depth only (the host is fixed before interpolation, so a bad value is a
  confusing failure, not token exfil). See `code-review-claude-2026-06-05.md` #25.
- **[Med] `BackupRun` shape carries vestigial bundle-era fields.**
  `packages/core/src/backup/runs.ts:23-25` — `bundle` is now repurposed to hold the
  pushed commit SHA, and `bytes`/`synced` are leftovers from the gzip-bundle era.
  Works and is tested, but the names lie. Rename `bundle → commit` and drop
  `bytes`/`synced`. Touches the `BackupRun` type + the dashboard runs-table.
- **[Low] Apply-failure log doesn't name `vault.pre-restore.bak`.** Only matters in
  the extreme double-rename fault where live data ends up in the `.bak`; a code
  comment notes it. Name the `.bak` path in the failure log so a panicked operator
  knows where their data is.
- **[Low] Concurrent `stageRestore` calls race on the staging dir.** Single-admin
  and recoverable today; a per-stage temp subdir or an in-process lock would harden
  it if multi-admin restore ever becomes real.
- **[Low / conditional] If the recall index is ever persisted under
  `<vault>/.index/`, add a `.gitignore` for it.** The index is in-memory today, so
  not yet load-bearing — but a future increment that writes it to disk must keep it
  out of the pushed vault.

---

## Storage / schema residue — SQLite removal (spec 040, build 2026-06-04)

- **[Low] The retired event-ledger *store seam* lingers (pending F10).** The
  `MemoryLedgerEntry` Zod schemas + the `MemoryEventType` enum were removed in **#309**
  (2026-06-05). What remains is the store-layer seam: `appendEvent()` / `listEvents()`
  throw `LEDGER_RETIRED` on markdown but stay on the `MemoryStore` interface, and
  `start_context` still calls `listEvents` (its parity test asserts the `/retired/`
  throw). Kept deliberately in case the **F10 logs-view git-history rework** reuses the
  shape; revisit when F10 lands.
- **[Low] Barrel omits two memory types.** `packages/core/src/index.ts` exports
  `Memory` / `MemoryStore` / `MemoryStoreDeps` but not `MemoryEvent` or
  `AppendMemoryEventOptions`, though both are part of the `MemoryStore` signature.
  Pre-existing; surface them for API consistency.
- **[Low] `memory-types.ts` header still flags a follow-up.** The `Memory` type is
  "intentionally loose; tightening to the Zod-derived `Memory` is a follow-up."
  Accurate today — revisit (and update the comment) when that tightening lands.

---

## Cross-repo / plugins — Workstream C plugin modernization (plan 2026-06-04)

- **[Med — verify] Confirm the 5 plugin repos got their lockstep conv-state +
  doc changes.** The canonical/main-repo half of Workstream C shipped here
  (`0f1454d` trimmed the conv-state block to `conv_id + off_record`; `e2b0ac2`
  fixed the curator/dedup skill guidance). The plan's **C2** was a *lockstep
  cross-harness contract*: the byte-identical `renderConvStateBlock` had to change
  in all five plugin repos together (claude / codex / opencode / pi / hermes),
  each dropping the removed `domain` line and the always-empty `session_id` line —
  plus **C3** doc modernization per repo. Those repos are external and can't be
  verified from this checkout. **Action:** confirm each plugin repo's PR merged and
  that all five rendered blocks match, or finish the stragglers.

---

## Resolved since first flagged (kept for the record)

These were flagged as deferred in the notes and have since shipped — listed so they
aren't re-investigated:

- Dead `CONSOLIDATOR_REQUIRES_MARKDOWN` / `unsupported_backend` skip path — removed
  in `3fbae36` (post-SQLite dead-code PR).
- Vacuous `store.backend === "markdown"` / `!== "markdown"` guards
  (`remember.ts`, `scripts/seed/lib.mjs`) — removed in `3fbae36`.
- Orphaned `test/fixtures/pre-migration/{events,sessions}.jsonl` — deleted (dir gone).
- Dashboard `/logs` + `/recall` event-ledger views and the empty By-category /
  By-scope analytics dimensions — removed in `be4c839`.
- The 14 `MemoryLedgerEntry` Zod schemas + the `MemoryEventType` enum /
  `MemoryEventTypeSchema` (the retired event-ledger schema layer) — removed in
  **#309** (2026-06-05).
- Cross-impl equivalence test between core `isAuthConfigComplete` and dashboard
  `configComplete` — added in **#310** (16-row table; the two agree everywhere).
- `backup.github.repo` `owner/repo` validation at the tRPC write boundary — added in
  **#311** (env/read-path residual re-filed above as [Low]).
- PR #143 (memories detail modal) — merged after the auth initiative; the
  memories-overflow e2e regression was fixed (`[&>*]:min-w-0` restored).
