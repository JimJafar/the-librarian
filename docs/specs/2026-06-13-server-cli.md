# Spec: `librarian server` — self-host the Librarian from the CLI

**Status:** Approved to build, 2026-06-13. From the feature doc
`proposals/2026-06-13-server-cli-feature.md` (now superseded by this spec).
Companion to the harness installer (shipped as `@the-librarian/cli`).

**Decisions locked (owner, 2026-06-13):**
- **All-in-one container only.** `server up` deploys the single
  `all-in-one.Dockerfile` image (the path `DEPLOYMENT.md` already calls
  recommended). The two-container compose stack stays a documented advanced
  path the CLI does **not** drive.
- **Deploy from the latest released tag**, with `--ref <tag|main>` as the
  escape hatch. `update` re-pins to the newest release. Pinning is for
  reproducibility, not freezing.
- **Fold a curated admin subset** (`backup`, `restore`, `auth`, `rebuild`)
  under `librarian server admin …`; drop `seed`; run `migrate-data-dir`
  automatically inside `update`, not as a user verb.

## 1. Objective

Stand up a Librarian **server** with one command, then hand its URL + token
straight to `librarian install` on clients. Today the CLI configures the
*client* side; the server still means clone-the-repo, hand-write `.env`,
`docker build/run`, wire boot persistence, and manage the master key. `librarian
server up` wraps that happy path so the Librarian is a self-contained product:
**server on the host → token → clients.**

Success: on a fresh Linux/macOS host with Docker, `librarian server up` builds
and starts the all-in-one container, prints the **MCP URL + a fresh agent
token**, and (if you want) writes this machine's own `~/.librarian/env` — and
`librarian server status` tells you it's healthy and whether a newer release
exists.

## 2. Shape

- One CLI, one new command group. `@the-librarian/cli` (`librarian`) keeps its
  harness commands and **gains** a `server` group. No rename, no second tool —
  it shares the existing config / env / http / exec / semver infrastructure.
- The `server` group is **host-only** and **Docker-driven**. It never runs the
  server as a bare `node`/`pnpm start`; "start the server" means build + run the
  all-in-one image. Client-only users never pay for it (Docker is needed only at
  `server up`, never at CLI install time).
- **Server config ≠ client config.** The harness installer writes the *client's*
  `LIBRARIAN_MCP_URL`/token to `~/.librarian/env` + the shell rc. The *server's*
  state is the deploy dir + the data **volume**. Different machine, different
  files, different purpose — never conflated.

## 3. Command surface

```
librarian server up        [--ref <tag|main>] [--dir <path>] [--host <bind>]
                           [--data-volume <name>] [--enable-boot] [--yes]
librarian server update    [--ref <tag|main>] [--yes]
librarian server down                          # stop the container (data kept)
librarian server status                        # running? healthy? version vs latest
librarian server logs      [-f] [--service mcp|dashboard|all]
librarian server enable-boot  /  disable-boot  # systemd unit (Linux); launchd deferred
librarian server admin <backup|restore|auth|rebuild> [args…]
```

`server` with no subcommand prints this surface; `librarian --help` reveals both
the harness and server groups.

## 4. `server up` flow

1. **Preflight.** Require `docker` (daemon reachable) and `git`. Each missing
   tool is a clear, actionable error (what to install), never a stack trace. On
   macOS, check Docker Desktop is running.
2. **Deploy dir.** Default `~/.librarian/server` (override `--dir`). If absent,
   `git clone` the monorepo there at the resolved ref (§7). If it's already our
   managed clone, `git fetch` + checkout the ref. If it exists but isn't our
   clone (different remote / dirty), stop and ask — never clobber a dir we
   didn't create (mirrors the installer's "ask before editing config we didn't
   write").
3. **Resolve the bind host.** Default `127.0.0.1` (local only). If a Tailscale
   tailnet IP is detected, offer it; `--host` sets it explicitly. We never
   default to `0.0.0.0` — exposing beyond the host is an explicit choice.
4. **Mint the agent token.** Generate one CSPRNG agent token (the loop-closer
   value). The **master key and admin token are NOT minted here** — the server
   auto-generates `LIBRARIAN_SECRET_KEY` (`/data/secret.key`) and, when bound
   beyond localhost, the admin token (`/data/admin.token`) on first boot. A
   fresh install needs zero secret env.
5. **Build + run.**
   `docker build -f docker/all-in-one.Dockerfile -t the-librarian:<tag> .` then
   `docker run -d --name the-librarian --restart unless-stopped --init
   -p <host>:3000:3000 -p <host>:3838:3838 -v <volume>:/data
   -e LIBRARIAN_AGENT_TOKEN=<minted> the-librarian:<tag>`.
   Data volume defaults to the named volume `librarian_data` (`--data-volume`).
6. **Wait for health.** Poll the container's healthcheck (both services healthy)
   with a bounded timeout; on failure, surface `docker logs --tail` and roll the
   run back cleanly (no half-up state).
7. **Capture the generated secrets.** Read them from the container, not by
   scraping logs: `docker exec the-librarian cat /data/secret.key` (and
   `/data/admin.token` when present). Surface the **master key once** with the
   `SAVE THIS KEY — excluded from backups` warning; surface the admin token once
   ("paste into the dashboard to enable auth"). Never write either to a host
   file or any log.
8. **Boot persistence (opt-in).** With `--enable-boot` (or an interactive
   prompt on Linux), generate + enable a `the-librarian.service` systemd unit
   (§8). macOS `launchd` is deferred — note it and skip.
9. **Close the loop.** Print the **MCP URL** (`http://<host>:3838/mcp`) and the
   minted **agent token**, ready to paste into `librarian install`. If this
   machine's own `~/.librarian/env` is absent/incomplete, **offer** to write it
   (so a single-box dev gets server + client in one shot) — offer, never force.

## 5. Secrets & identity (what generates, what prompts, what we surface)

| Value | Source | CLI behaviour |
|---|---|---|
| `LIBRARIAN_SECRET_KEY` (AES-256, 64 hex) | server auto-gen → `/data/secret.key` (0600) | read back, surface once with SAVE warning; never persisted host-side |
| Admin token | server auto-gen → `/data/admin.token` (0600), only when bound beyond localhost | read back, surface once; used for `server admin auth` + dashboard auth enablement |
| Agent token | **CLI mints** one CSPRNG value | passed as `-e LIBRARIAN_AGENT_TOKEN`; printed as the loop-closer; offered into local `~/.librarian/env` |
| Dashboard owner login (OAuth/password) | dashboard wizard at `/settings/auth` | **not prompted** — `up` points the user at the wizard (env auth path is deprecated) |
| Bind host / data UID-GID | prompt/flag/default | `--host`; volume owner handled by the image's `node` user (UID 1000) |

Boundaries: a bearer token never lands in a committed/world-readable file, a
log, or an error message; surfacing the key/admin-token is a one-time terminal
print (the server's own sanctioned path), not a write.

## 6. Folded-in admin (`server admin …`)

Same audience as `server` (the host), so a curated subset of the existing
`@librarian/cli` (`the-librarian`) moves under `librarian server admin`:

| `server admin` | Maps to | Notes |
|---|---|---|
| `backup` | `the-librarian backup` | push the vault (a git repo) to the configured GitHub backup remote |
| `restore` | **new** `the-librarian restore` | clone the backup remote into the data dir; prompt for `--secret-key` (excluded from backups). **Build this — it doesn't exist yet** |
| `auth status\|reset-password\|disable` | `the-librarian auth …` | dashboard-login lockout recovery from the host shell; must work even when the UI is locked |
| `rebuild` | `the-librarian rebuild` | regenerate the disposable in-memory recall index from the vault |

**Dropped / not exposed:**
- `seed` — empty-store dev bootstrap (2 policy memories); not an operator need.
- `migrate-data-dir` — not a user verb; `server update` runs pending data-dir
  migrations automatically after pulling a new version.

**Mechanism.** The all-in-one image does **not** bundle `@librarian/cli` today
and the data lives in the container's volume, so:
- Add `@librarian/cli` (built `dist` + its bin) to `all-in-one.Dockerfile`'s
  runtime tree.
- `server admin <cmd>` runs `docker exec the-librarian the-librarian <cmd>` —
  one uniform mechanism with direct data-dir access. This is what lets `auth`
  recovery bypass the (possibly-locked) dashboard, and lets `backup`/`restore`
  reuse the store + settings rather than re-implementing them.

## 7. Versioning & updates

- **Resolve-ref.** Default = the latest `vX.Y.Z` GitHub release tag (reuses the
  installer's "latest" source + `compareVersions`). `--ref` pins an explicit tag
  or `main` (bleeding edge; what guybrush tracks).
- **`server update`** = fetch tags → checkout the resolved ref → rebuild the
  image → recreate the container (volume preserved) → **run pending data-dir
  migrations** → wait for health. Idempotent: already at the ref + healthy → a
  clean no-op. This is a cleaned-up, tag-pinned successor to
  `pull-and-restart.sh` (stash/branch dance dropped; it owns its deploy dir).
- **`server status`** shows: container running?, health, the **deployed
  version** (the checked-out tag), the **latest release**, and an
  `up-to-date / update-available` badge — the same comparison the dashboard's
  Phase-2 Installs view uses, applied to the server itself.

## 8. Boot persistence

- **Linux (systemd).** Generate `~/.config/systemd/user/the-librarian.service`
  (or system unit with `--system`) whose `ExecStart` is the resolved
  `docker run` and `ExecStop` is `docker stop`; `enable --now`. Idempotent;
  `disable-boot` reverses it. (Today's guybrush unit is ad-hoc — this makes it
  reproducible.)
- **macOS (launchd).** Deferred for v1: `up` notes that boot persistence is
  Linux-only for now and skips it cleanly. A follow-up adds a `launchd` plist.

## 9. Structure / stack / testing

- New module group under `packages/installer-cli/src/server/`: `up.ts`,
  `update.ts`, `down.ts`, `status.ts`, `logs.ts`, `boot.ts`, `admin.ts`, plus a
  `docker.ts` seam wrapping `docker`/`git` invocations (mirrors the existing
  `exec.ts`/`setRunner` injection so tests never touch a real daemon).
- Reuse existing infra: `semver.ts` (version compare), the latest-release
  fetcher, `prompt.ts`, `paths.ts`, machine detection.
- `all-in-one.Dockerfile` gains the `@librarian/cli` runtime tree (for §6).
- **Vitest**, same pattern as the harness modules: a fake runner asserts the
  exact `docker`/`git` argv for each command; `up` rollback on a failed health
  wait; `update` no-op when already at ref; `status` table from stubbed
  `docker inspect` + a stubbed latest-release; `admin` dispatch builds the right
  `docker exec`. No test starts a real container.
- A `--remote` healthcheck path already exists (`pnpm run healthcheck --remote
  <url> --agent-token …`) — `up`/`status` reuse it to verify a live stack.

## 10. Boundaries

- **Always:** idempotent operations; preflight every external tool with a
  teaching error; never leave a half-up deploy (roll the container back on a
  failed `up`); the data volume is sacred across `update`/`down` (never
  removed); one change per PR with version bump + CHANGELOG + tests.
- **Ask first:** reusing/overwriting a deploy dir we didn't create; binding
  beyond `127.0.0.1`; writing this machine's `~/.librarian/env` during `up`.
- **Never:** print or persist the master key / admin token to a file or log
  (one-time terminal surfacing only); deploy `0.0.0.0` by default; run the
  server outside Docker; expose `seed`/`migrate-data-dir` as routine verbs;
  bundle the admin surface in a way that needs the dashboard for auth recovery.

## 11. Success criteria

1. `librarian server up` on a clean Docker host → image built, container healthy,
   MCP URL + agent token printed; pasting them into `librarian install` on a
   client connects.
2. `up` surfaces the auto-generated master key + admin token exactly once, with
   the save-the-key warning, and writes neither to disk.
3. `server status` reports health, deployed version, latest release, and a
   correct update badge; `server update` moves to the latest release, preserves
   the data volume, runs pending data-dir migrations, and ends healthy.
4. `server down` stops the container without touching data; a later `up`/`update`
   brings the same data back.
5. `--enable-boot` survives a reboot (Linux); `disable-boot` reverses it.
6. `server admin backup` pushes the vault; `server admin restore` rebuilds a data
   dir from the remote given the secret key; `server admin auth reset-password`
   clears a lockout even with the dashboard enforcing auth.
7. No token/key appears in any committed file, log, or error message; `pnpm
   test`/`typecheck`/`lint` green; PR bumps version + CHANGELOG.

## 12. Task plan

- **S1** `server/docker.ts` seam (inject `docker`/`git` runner) + preflight; wire
  the `server` group into the arg parser + `--help`.
- **S2** `up`: deploy-dir clone/fetch at ref, agent-token mint, build+run, health
  wait + rollback, secret capture/surface, loop-closer + optional `~/.librarian/env`.
- **S3** `down` / `logs` / `status` (deployed-vs-latest via existing semver + release fetcher).
- **S4** `update` (re-pin + rebuild + recreate + pending data-dir migrations, idempotent).
- **S5** `boot` (systemd unit gen/enable/disable; macOS deferred note).
- **S6** Bundle `@librarian/cli` into `all-in-one.Dockerfile`; `admin` dispatch via
  `docker exec`; **build the new `the-librarian restore`** command.
- **S7** Docs: `DEPLOYMENT.md` gains a "one-command self-host" section; README server blurb.
- **S8** Gate: tests/lint/typecheck green, version bump + CHANGELOG, PR.

## 13. Deferred (explicitly out of scope for v1)

- Prebuilt image distribution (publish the all-in-one image to GHCR on release
  so `up` can `docker run` a tag without `git clone` + local build) — a natural
  follow-up to the npm auto-publish, removes the git/build dependency from `up`.
- macOS `launchd` boot persistence.
- The two-container compose path under the CLI (stays manual/advanced).
- k8s / fly.io / bare-metal / Windows (stay in `DEPLOYMENT.md`).
- Multi-host: the server is single-instance per host; `server status` is
  host-local. Tracking several *client* machines is the dashboard's Phase-2
  Installs view — distinct from the server, which needs no machine-id treatment.
