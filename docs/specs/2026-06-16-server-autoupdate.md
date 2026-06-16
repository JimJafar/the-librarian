# Spec: server auto-update — host-scheduled, CLI + dashboard configurable

**Status:** Ready to build (owner-authorized overnight, 2026-06-16). Written with the
`sdlc-spec` method, grounded against the `librarian server` command surface on `main`.

## 1. Objective

Let an operator keep their self-hosted Librarian server current automatically, and
toggle/configure it from **both** the `librarian` CLI **and** the dashboard — without
the dashboard ever holding host/docker privileges.

## 2. The architectural constraint (drives the whole design)

`librarian server update` is **host-level**: it rebuilds the image and `docker rm`s +
recreates the container (data volume preserved). A process **inside** the container
cannot recreate its own container, and the container has **no docker-socket access**
(by design — a web-facing dashboard with `docker.sock` = host root). So:

- The **act** of updating must run on the **host** (a scheduled job).
- The dashboard can only ever **configure** auto-update (write a setting); it cannot
  perform it.

**Design:** a host-installed scheduler (systemd timer, cron fallback) runs frequently
and invokes a wrapper `librarian server autoupdate --run`. The wrapper reads two
**settings** from the server and a due-check, then conditionally calls
`server update`. The dashboard (and CLI) write those settings. This decouples *what's
configured* (settings, editable anywhere) from *who acts* (the host wrapper).

## 3. Success criteria (each → a test)

1. **CLI enable.** `librarian server autoupdate enable [--cadence daily|weekly]`
   installs a systemd timer (oneshot service + timer unit) — or a cron entry where
   systemd is unavailable — that periodically runs `librarian server autoupdate --run`;
   sets the `enabled` + `cadence` settings; idempotent (re-run = no dup units).
2. **CLI disable / uninstall.** `autoupdate disable` flips the setting off (timer
   stays installed → next run no-ops). `autoupdate uninstall` removes the timer/cron
   entirely. Both idempotent.
3. **CLI status.** `autoupdate status` shows: timer installed?, enabled?, cadence,
   last auto-update at, server up-to-date? (reuses `server status`' version/latest).
4. **The wrapper (`--run`) is correctly gated.** It updates **iff** `enabled` **and**
   the cadence has elapsed since the last auto-update (a due-check mirroring the
   intake sweep's `isIntakeSweepDue`); otherwise it logs a one-line skip and exits 0.
   On a successful update it stamps `last_run_at`. It reads the settings from the
   running server (admin tRPC / a status read); **if the server is unreachable it
   SKIPS** (conservative — never auto-update a server in an unknown state) and logs.
5. **Settings exist + are admin-editable.** `server.autoupdate.enabled` (bool),
   `server.autoupdate.cadence` (`daily|weekly`), `server.autoupdate.last_run_at`
   (ISO) live in the settings store (plain settings, like `curator.intake.*`), with
   read/write helpers + an admin tRPC route.
6. **Dashboard configures it.** A settings panel (toggle + cadence select + a
   read-only status line: timer-installed, last-run, update-available) reads/writes
   the settings via tRPC. When the timer isn't installed it shows a hint to run
   `librarian server autoupdate enable` on the host (the dashboard can't install it).
7. **Rollback-safe.** The wrapper relies on `server update`'s existing
   health-check-and-rollback; a failed update leaves the prior container running and
   the wrapper logs the failure (and does NOT stamp `last_run_at`, so it retries).
8. **Contracts + release.** Tests green (`pnpm test`/typecheck/lint/guards); version
   bump + CHANGELOG.

## 4. Key decisions

- **Timer fires frequently (e.g. hourly); the cadence is a due-check, not the timer
  period.** This lets the dashboard change cadence (a setting) with **no host
  action** — the wrapper just changes when it considers itself due. (Mirrors the
  intake sweep: fixed poll + `interval_minutes` setting + last-run timestamp.)
- **systemd timer preferred, cron fallback.** Reuse the boot/systemd handling in
  `packages/installer-cli/src/server/boot.ts` / `runtime.ts`. User vs system scope:
  match how `boot.ts` installs persistence.
- **Wrapper reads settings from the running server** (admin tRPC over the internal
  listener, or a small read), not the docker volume directly (a named volume isn't a
  clean host path). Server-unreachable → skip (SC 4).
- **`enabled`/`cadence`/`last_run_at` are plain settings** (no master key needed),
  consistent with `curator.intake.*`.
- **Dashboard never performs the update** — only writes settings; the host timer acts.

## 5. Out of scope

- Pulling pre-built release images from a registry (the current `update` rebuilds
  locally; a GHCR-publish + `docker pull` fast-path is a separate, adjacent spec).
- A dashboard "Update now" button that *performs* an update (would need host access /
  a sidecar — explicitly deferred; the toggle + the host timer is the safe path).

## 6. Task plan

- **T1 — settings + helpers (core).** `server.autoupdate.{enabled,cadence,last_run_at}`
  keys + read/write helpers + an `isAutoUpdateDue(store)` due-check (mirror
  `intake-config.ts`). Tests. *(@librarian/core)*
- **T2 — admin tRPC.** A `autoupdate` tRPC router (or extend `health`/an existing
  admin router): `get` (settings + timer-installed? + server version/latest) and
  `set` (enabled, cadence). Tests. *(@librarian/mcp-server)*
- **T3 — CLI `server autoupdate` + the timer.** `enable|disable|uninstall|status|--run`
  in `packages/installer-cli/src/server/autoupdate.ts`, wired in `runtime.ts`/`server/index.ts`;
  systemd unit+timer install (cron fallback) reusing `boot.ts`; the `--run` wrapper
  (read settings via tRPC → due-check → `server update` → stamp). Tests with a fake
  home/systemd + stub. *(installer-cli)*
- **T4 — dashboard panel.** A settings UI (toggle + cadence + status) consuming the T2
  tRPC; the "install on host" hint when the timer isn't present. Tests. *(apps/dashboard)*
- **T5 — release gate.** version bump + CHANGELOG; full gate green; PR.

## 7. Checkpoint

T1→T3 are the functional core (auto-update works, CLI-controlled, dashboard-readable
settings). T4 is the dashboard UX. Ship as one feature PR; if T4 is at risk, T1–T3 are
independently complete and shippable, with T4 as a fast-follow.
