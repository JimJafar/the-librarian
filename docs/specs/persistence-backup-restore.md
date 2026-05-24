# Spec: Backup / restore / export + cloud sync

## Status

Drafted 2026-05-24. Four serial PRs (B1–B4). Phase 2 of the "reduce self-hosting friction"
initiative (Deploy → Persistence → Auth). Do this **after** the Deploy spec and **before** the
Auth spec — once the tool is giftable and runs remotely, the highest-regret failure is data loss,
and Auth (next) starts writing token state into the DB, so backup must exist first.

## Objective

Make persistence **low-maintenance**. Today a self-hoster must manually back up *both* the JSONL
ledgers and the SQLite DB, with no built-in tooling — a real adoption barrier and a data-loss
risk. Ship built-in **backup / restore / export** plus an optional **sync to cloud object storage**,
and document volume snapshots. Keep `node:sqlite` (no async refactor, no libSQL/Turso).

**The current state.**

- Single `new DatabaseSync(dbPath)` at `packages/core/src/store/librarian-store.ts:63`. The store
  exposes `db`, `dbPath`, `eventsPath`, `sessionsPath`, `sessionsLegacyPath`, `snapshotPath`,
  `dataDir` on its interface.
- `LIBRARIAN_DATA_DIR` holds: `events.jsonl` (**memory canonical**, append-only),
  `session_events.jsonl` (timeline), `librarian.sqlite` (**sessions canonical post-R3**, memory
  projection), `memories.md` (derived). `sessions.legacy.jsonl` may exist if the R3 migration ran.
- Schema via `PRAGMA user_version` (`PROJECTION_SCHEMA_VERSION=11` in `projection.ts`); idempotent
  `ensureSchema` + rebuild-from-JSONL (`rebuildIndex`). `getSchemaVersion(db)` reads the version.
- `settings-store.ts` provides `setSetting/getSetting/deleteSetting/listSettings` with optional
  AES-256-GCM encryption keyed by `LIBRARIAN_SECRET_KEY` (already used for the curator LLM token).
- `packages/cli` is a `runCli(argv, store)` dispatcher (`rebuild`, `seed`, `sessions …`) — the home
  for `backup/restore/export`.
- **No** built-in backup/restore/export exists today; docs recommend manual `cp -a data`.

**Success means:** `the-librarian backup` produces a consistent, restorable snapshot of the whole
store; `the-librarian restore` brings it back identically; an optional `--sync` pushes it to S3-compatible
storage; the dashboard has a "Backup now" action; and `DEPLOYMENT.md` documents volume snapshots.

## Non-goals

- **Not swapping the database.** libSQL/Turso/Postgres are explicitly out — the exploration showed
  a ~500-LOC async refactor and a remote-rebuild latency cliff (500+ queries). Keep `node:sqlite`.
- **Not point-in-time/continuous replication.** Snapshot-based backup (manual + scheduled) is the
  bar; PITR/replication is a future option if zero-RPO is ever needed.
- **Not a global write-lock.** Single-owner + the synchronous store means a backup taken between
  requests is point-in-time, and `VACUUM INTO` is transactionally consistent regardless.
- **Not multi-cloud at once.** S3-compatible first (covers AWS, Cloudflare R2, MinIO, Backblaze via
  an `endpoint` override) behind an interface so GCS/others are a later drop-in.

## Decisions (resolved)

- **Consistent snapshot via `db.exec("VACUUM INTO '<tmp>'")`** for SQLite (a clean, transactionally
  consistent copy under a live connection, valid under rollback journal mode), plus a copy of the
  append-only JSONL ledgers taken in the same quiescent window. Bundle with a `manifest.json`
  (schema version, file list, checksums, created_at).
- **Archive = plain directory bundle** (`backup-<ts>/` with the files + `manifest.json`), zero-dep
  and transparent to restore; gzip individual large files via `node:zlib`. (Rejected adding a `tar`
  dependency for v1.)
- **Cloud SDK = `@aws-sdk/client-s3`, optional + lazy-imported** so core stays slim and the CLI
  works without it installed. (Rejected hand-rolled SigV4 — more code, more risk.)
- **Credentials live in encrypted secret settings** via `settings-store` (`{secret:true}`,
  requires `LIBRARIAN_SECRET_KEY`), exactly like the curator token; env fallback for headless setups.
- **Backup/restore/export live in `@librarian/core`** (pure, testable), wrapped thinly by the CLI
  and, for "Backup now", by a new admin tRPC procedure the dashboard calls.

## Tech stack

- `node:zlib` (gzip), `node:fs`, `node:crypto` (checksums) — no new required deps.
- `@aws-sdk/client-s3` — **optional** dependency, lazy-imported only when sync is used.
- Reuses `settings-store` encryption, `projection.ts` (`getSchemaVersion`, `rebuildIndex`,
  `ensureSchema`), `store/jsonl.ts` (`readJsonl`), the CLI `parseFlags`/`CliResult`, and the
  curator's `createSerialScheduler` + admin-router/cockpit patterns.

## Plan (PRs)

### B1 — Core backup / restore / export module

- **Create** `packages/core/src/backup/backup.ts` — `createBackup(store, { destDir }): { path, manifest }`:
  `store.db.exec("VACUUM INTO ?")` to a temp path; copy `store.eventsPath` / `sessionsPath` /
  `sessionsLegacyPath` (if present) / `snapshotPath`; write `manifest.json` with
  `getSchemaVersion(store.db)`, file list + SHA-256 checksums, `created_at`; assemble the directory
  bundle (gzip large files).
- **Create** `packages/core/src/backup/restore.ts` — `restoreBackup(archivePath, { dataDir })`:
  validate the manifest + checksums; atomically swap files into `dataDir` (move the old aside,
  move the new in); leave SQLite for the store to re-open, or rebuild from JSONL via `rebuildIndex`
  if the manifest schema version differs. Reject a corrupt/mismatched archive.
- **Create** `packages/core/src/backup/export.ts` — `exportData(store, { format })`: portable
  NDJSON/JSON of memories + sessions via `readEvents` / `readSessionEvents` / `listAll`.
- **Create** tests `packages/core/tests/backup/{backup,restore,export}.test.ts`.
- **Reuse**: the store path getters + `db`; `getSchemaVersion`/`rebuildIndex`; `readJsonl`.
- **Tests (RED first — highest value)**: seed a store → `createBackup` → wipe `dataDir` →
  `restoreBackup` → reopen → assert `listAll()` + `listSessions()` identical to pre-backup; manifest
  carries schema 11; corrupt-archive rejection; export round-trips memory + session counts.
- **Acceptance**: full round-trip is byte-faithful for data; corrupt archives are refused.

### B2 — CLI subcommands

- **Modify** `packages/cli/src/runtime.ts` — add `backup`, `restore`, `export` to the top-level
  dispatch and `usage()` (alongside `rebuild`/`seed`).
- **Create** `packages/cli/src/commands/{backup,restore,export}.ts` — thin wrappers over the core
  module returning `CliResult`; flags via `parseFlags`: `--out <dir>`, `--from <archive>`,
  `--format ndjson|json`, and `--force` (required for the destructive restore; restore prints a
  confirmation line and refuses without `--force`).
- **Reuse**: `runCli` dispatch, `CliResult`, `parseFlags`, `_shared.ts`.
- **Tests**: `packages/cli/tests/` — `runCli(["backup","--out",tmp], store)` writes an archive;
  restore reuses the core round-trip via the CLI surface; restore without `--force` is a no-op error.
- **Acceptance**: `the-librarian backup|restore|export` work against a local store.

### B3 — Pluggable cloud sync (S3-compatible)

- **Create** `packages/core/src/backup/sync/types.ts` — `interface BackupTarget { put(name, bytes), list(), get(name) }`.
- **Create** `packages/core/src/backup/sync/s3.ts` — S3-compatible impl via lazy
  `import("@aws-sdk/client-s3")`; supports `endpoint` override (R2/MinIO/Backblaze). Reads config
  from `settings-store` (`backup.s3.endpoint`, `backup.s3.bucket`, `backup.s3.region` plain;
  `backup.s3.access_key`, `backup.s3.secret_key` as `{secret:true}`), env fallback `LIBRARIAN_BACKUP_S3_*`.
- **Modify** `backup.ts` / the CLI `backup` command to accept `--sync` (upload after creating) and
  `restore --from s3://…`.
- **Create** `packages/core/tests/backup/sync/s3.test.ts`.
- **Tests**: a `BackupTarget` contract test against an in-memory fake; the S3 impl against a mocked
  client; a `settings-store` round-trip for the (secret) credentials.
- **Acceptance**: `backup --sync` puts an object in the bucket; `restore --from s3://…` restores;
  credentials never appear in logs or `listSettings` output.

### B4 — Dashboard action + optional schedule + docs

- **Create** `packages/mcp-server/src/trpc/backup.ts` — `adminProcedure` router: `createNow`
  (mutation → `createBackup(ctx.store, …)` + optional sync), `list` (recent backups), `config` /
  `setConfig` (sync settings; never returns secrets). Mount in `trpc/router.ts` as `backup`.
- **Create** `apps/dashboard/app/backups/{page.tsx,actions.ts}` — a "Backup now" + "Download backup"
  surface, Server Action calling `serverTRPC.backup.createNow` (clone `app/curator/*`).
- **Optional schedule**: reuse `createSerialScheduler` (as the curator tick in `bin/http.ts`),
  gated on `LIBRARIAN_BACKUP_INTERVAL_MS` (0 = off) + sync config present; start it in `bin/http.ts`.
- **Modify** `DEPLOYMENT.md` — add a "Volume snapshots" section (Fly volume snapshots;
  `docker run --rm -v librarian_data:/data busybox tar …`) and document the backup commands +
  cloud-sync config + the `LIBRARIAN_SECRET_KEY` caveat (losing it loses encrypted *settings* —
  curator token, S3 creds — but **not** memories/sessions, which are plaintext JSONL/SQLite).
- **Reuse**: `adminProcedure`, `createSerialScheduler`, the curator config-form components.
- **Tests**: `packages/mcp-server/tests/trpc/backup.test.ts` (admin-gated; `createNow` writes an
  archive against a temp store); a dashboard action test mirroring `tests/memories-actions.test.ts`.
- **Acceptance**: "Backup now" produces a listed archive; a low `LIBRARIAN_BACKUP_INTERVAL_MS`
  produces a scheduled backup; docs cover snapshots + sync.

## Verification (end-to-end)

```
the-librarian backup --out /tmp/bk          # archive + manifest.json (files + schema 11)
# round-trip:
the-librarian seed                          # or use a populated store
the-librarian backup --out /tmp/bk
rm -rf "$LIBRARIAN_DATA_DIR"/*
the-librarian restore --from /tmp/bk/<archive> --force
the-librarian sessions list                 # identical to pre-backup
# MCP-level: recall + list_sessions return identical results before/after
# cloud: backup --sync (with LIBRARIAN_BACKUP_S3_* or settings) → object in bucket; restore --from s3://…
# dashboard: /backups → "Backup now" → archive listed; set LIBRARIAN_BACKUP_INTERVAL_MS low → scheduled backup appears
```

Core round-trip test + CLI tests + tRPC test green; `pnpm -w test` green.

## Risks / open items

- **Quiescence**: no write-lock; `VACUUM INTO` is consistent for SQLite and JSONL is append-only,
  so a between-request backup is consistent for single-owner traffic. If hard guarantees under
  concurrent agent writes are ever needed, add an advisory lock — deferred.
- **Restore is destructive** — guarded by `--force` + a printed confirmation (CLI) and an explicit
  confirm (dashboard).
- **`@aws-sdk/client-s3` optionality** — lazy import must degrade with a clear "install … to use
  cloud sync" error when absent.
- **`LIBRARIAN_SECRET_KEY` load-bearing** for sync credentials — documented; its loss is recoverable
  (re-enter creds), and never affects memory/session data.
