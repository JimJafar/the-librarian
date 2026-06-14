# Spec: `librarian server` — self-host the Librarian from the CLI

**Status:** Approved to build, 2026-06-13. Written with the `sdlc-spec` method
(testable success criteria → ordered, vertically-sliced tasks). Supersedes the
pre-spec feature doc `proposals/2026-06-13-server-cli-feature.md` (content stays
in git history on `docs-server-cli-feature`). Companion to the harness installer
spec (`docs/specs/2026-06-13-installer-cli.md`).

## 1. Objective

Stand up a Librarian **server** with one command, then hand its URL + token
straight to `librarian install` on clients. Today the CLI configures only the
*client* side; the server still means clone-the-repo, hand-write `.env`,
`docker build/run`, wire boot persistence, and manage the master key. `librarian
server up` wraps that happy path so the Librarian is a self-contained product:
**server on the host → token → clients.** Audience: a self-hoster on a single
Linux/macOS Docker host (the same person who runs `librarian install` on their
clients).

On a fresh host with Docker, `librarian server up` builds and starts the
all-in-one container, prints the **MCP URL + a fresh agent token**, optionally
writes this machine's own `~/.librarian/env`, and `librarian server status` tells
you it's healthy and whether a newer release exists.

## 2. Success criteria

The acceptance bar. Each is a pass/fail condition; the build (`sdlc-implement`)
turns each into a test. "argv" = the exact `docker`/`git` argument vector
asserted against the injected fake runner (no test starts a real container).

1. **Loop closes.** On a clean Linux host with Docker + git, `librarian server
   up` (no flags) clones the monorepo at the latest release tag into
   `~/.librarian/server`, builds `the-librarian:<tag>`, runs the all-in-one
   container, both services report `healthy` within the timeout, and the command
   prints the MCP URL `http://127.0.0.1:3838/mcp` **and** a freshly minted agent
   token. Pasting that URL + token into `librarian install` on a client lets a
   `recall` round-trip.
2. **Master key surfaced once, never persisted.** After a fresh `up`, the
   auto-generated master key (read back from `/data/secret.key`) is printed
   exactly once with the `SAVE THIS KEY — excluded from backups` warning, and
   appears in **no** host file under the deploy dir and **no** log.
3. **Localhost vs beyond-localhost auth is correct (§6).** A default
   (`127.0.0.1`) `up` passes `-e LIBRARIAN_ALLOW_NO_AUTH=true` and the server
   generates **no** admin token; an `up --host <tailnet-ip|0.0.0.0>` omits that
   flag, the server generates `/data/admin.token`, and the CLI surfaces it once.
   (Asserted on the differing `docker run` argv + which secrets are surfaced.)
4. **`status` reports truth.** `server status` shows running?, health, the
   **deployed version** (checked-out tag), the **latest release**, and a correct
   `up-to-date | update-available` badge — verified against a stubbed
   `docker inspect` + a stubbed latest-release fetch.
5. **`update` re-pins forward and is idempotent.** `server update` fetches tags,
   checks out the newest `vX.Y.Z`, rebuilds the image, recreates the container
   **preserving** the `librarian_data` volume, runs pending data-dir migrations,
   and ends healthy. Already at the latest release + healthy → a clean no-op (no
   build/run argv).
6. **Data is sacred.** `server down` argv contains `docker stop` and **never**
   `docker rm -v` / `docker volume rm`; a later `up`/`update` recalls the same
   memories.
7. **Boot persistence (Linux).** `up --enable-boot` (or the interactive prompt)
   generates and enables a `the-librarian.service` systemd unit whose `ExecStart`
   is `docker start --attach the-librarian` — it references the **existing** named
   container and carries **no secret** (never the resolved `docker run`, which
   would leak the agent token into the world-readable unit file); the container
   restarts after a reboot; `disable-boot` reverses it. macOS prints a
   "Linux-only for now" notice and skips cleanly.
8. **Admin works even when the dashboard is locked.** The built all-in-one image
   has `the-librarian` on `PATH`; `server admin <backup|restore|auth|rebuild> …`
   runs `docker exec the-librarian the-librarian <cmd> …`, and `server admin auth
   reset-password` clears a lockout while the dashboard is enforcing auth.
9. **`restore` exists and round-trips.** The newly built `the-librarian restore`,
   given the backup git remote + a supplied `--secret-key`, clones the backup
   into the data dir and the server decrypts restored secrets; a missing key
   prompts (it is excluded from backups) with a teaching message.
10. **No leaks, releasable.** No agent token, admin token, or master key appears
    in any committed file, log, or error message across all `server` commands.
    `pnpm test` / `typecheck` / `lint` green; PR bumps root `package.json` +
    dated `CHANGELOG` entry (`check:release` green).

## 3. Shape

- **One CLI, one new command group.** `@the-librarian/cli` (`librarian`) keeps
  its harness commands and **gains** a `server` group — no rename, no second
  tool. It reuses the existing config / env / http / exec / semver infra.
- **Host-only and Docker-driven.** `server` never runs the server as a bare
  `node`/`pnpm start`; "start the server" means build + run the all-in-one image.
  Client-only users pay nothing (Docker is needed only at `server up`).
- **Server config ≠ client config.** The installer writes the *client's*
  `LIBRARIAN_MCP_URL`/token to `~/.librarian/env`. The *server's* state is the
  deploy dir + the named data **volume**. The deploy dir defaults to
  `~/.librarian/server` (a subdir of the same tree), but the two are never
  conflated — different files, different purpose.

## 4. Command surface

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

## 5. `server up` flow

1. **Preflight.** Require `docker` (daemon reachable) and `git`; each missing
   tool is a teaching error (what to install), never a stack trace. On macOS,
   check Docker Desktop is running.
2. **Deploy dir.** Default `~/.librarian/server` (`--dir` overrides). Absent →
   `git clone` the monorepo at the resolved ref (§8). Already our managed clone →
   `git fetch` + checkout the ref. Exists but isn't our clone (different remote /
   dirty) → stop and ask; never clobber a dir we didn't create.
3. **Resolve the bind host.** Default `127.0.0.1` (host loopback only). A
   detected Tailscale tailnet IP is offered; `--host` sets it explicitly. We
   never default to `0.0.0.0` — exposing beyond the host is an explicit choice
   (and `0.0.0.0` is ask-first).
4. **Mint the agent token.** Generate one CSPRNG agent token (the loop-closer).
   The **master key and admin token are NOT minted here** — the server
   auto-generates `LIBRARIAN_SECRET_KEY` (`/data/secret.key`) and, when bound
   beyond localhost, the admin token (`/data/admin.token`) on first boot (§6). A
   fresh localhost install needs zero secret env.
5. **Build + run.**
   `docker build -f docker/all-in-one.Dockerfile -t the-librarian:<tag> .` then
   `docker run -d --name the-librarian --restart unless-stopped
   -p <host>:3000:3000 -p <host>:3838:3838 -v <volume>:/data
   -e LIBRARIAN_AGENT_TOKEN=<minted> [ -e LIBRARIAN_ALLOW_NO_AUTH=true ]
   the-librarian:<tag>`. The image already runs `tini` as PID 1, so `--init` is
   omitted. The `ALLOW_NO_AUTH` flag is added **only** for a `127.0.0.1` bind
   (§6). Data volume defaults to the named volume `librarian_data`
   (`--data-volume`); ports 3838 = MCP (`/mcp`, `/healthz`), 3000 = dashboard
   (`/api/health`).
6. **Wait for health + roll back on failure.** Poll
   `docker inspect --format '{{.State.Health.Status}}' the-librarian` until
   `healthy`, bounded timeout. On failure, surface `docker logs --tail` and
   remove the container (no half-up state).
7. **Capture generated secrets from the container, not the logs.**
   `docker exec the-librarian cat /data/secret.key` (and `/data/admin.token` when
   present). Surface the **master key once** with the `SAVE THIS KEY` warning;
   surface the admin token once ("paste into the dashboard to enable auth").
   Write neither to a host file or any log.
8. **Boot persistence (opt-in).** With `--enable-boot` (or an interactive prompt
   on Linux), generate + enable a `the-librarian.service` systemd unit (§9). On
   macOS, note that boot persistence is deferred and skip.
9. **Close the loop.** Print the **MCP URL** (`http://<host>:3838/mcp`), the
   dashboard URL (`http://<host>:3000`), and the minted **agent token**, ready to
   paste into `librarian install`. If this machine's own `~/.librarian/env` is
   absent/incomplete, **offer** to write it (single-box dev gets server + client
   in one shot) — offer, never force.

## 6. Secrets & identity

| Value | Source | CLI behaviour |
|---|---|---|
| `LIBRARIAN_SECRET_KEY` (AES-256, 64 hex) | server auto-gen → `/data/secret.key` (0600) on first boot | read back, surface once with SAVE warning; never persisted host-side |
| `LIBRARIAN_ADMIN_TOKEN` | server auto-gen → `/data/admin.token` (0600), **only when bound beyond localhost** | read back, surface once; used for `server admin auth` + dashboard auth |
| `LIBRARIAN_AGENT_TOKEN` | **CLI mints** one CSPRNG value | passed as `-e LIBRARIAN_AGENT_TOKEN`; printed as the loop-closer; offered into local `~/.librarian/env` |
| Dashboard owner login (OAuth/password) | dashboard wizard at `/settings/auth` | **not prompted** — `up` points the user at the wizard (env auth path is deprecated) |
| Bind host | prompt/flag/default | `--host`; volume owner is the image's `node` user (UID 1000) |

**How "only when bound beyond localhost" is realized (grounded correction).** The
all-in-one image hard-codes `LIBRARIAN_HOST=0.0.0.0` so the in-container socket is
always reachable through Docker's port publishing
(`docker/all-in-one.Dockerfile`). The server derives "bound beyond localhost"
from `LIBRARIAN_HOST` / `LIBRARIAN_ALLOW_NO_AUTH`, **not** from the host-side
publish address (`packages/mcp-server/src/bin/http.ts:38-64`). So in this image
the server would *always* think it's bound beyond localhost and *always* generate
an admin token. The CLI therefore maps the operator's bind choice to the existing
`LIBRARIAN_ALLOW_NO_AUTH` knob:

- **`--host 127.0.0.1` (default):** pass `-e LIBRARIAN_ALLOW_NO_AUTH=true` → no
  admin token, localhost no-auth bypass (only reachable via host loopback).
- **`--host <tailnet-ip|0.0.0.0>`:** omit the flag → server generates +
  enforces the admin token.

This is the load-bearing mechanism for success criterion 3; see Open Question 1
for the exact enforcement scope of `ALLOW_NO_AUTH`.

**Boundaries.** A bearer token never lands in a committed/world-readable file, a
log, or an error message; surfacing the key/admin-token is a one-time terminal
print (the server's own sanctioned path), not a write.

## 7. Folded-in admin (`server admin …`)

Same audience as `server` (the host), so a curated subset of the existing
`@librarian/cli` (`the-librarian`) moves under `librarian server admin`:

| `server admin` | Maps to | Notes |
|---|---|---|
| `backup` | `the-librarian backup` | push the vault (a git repo) to the configured GitHub backup remote |
| `restore` | **new** `the-librarian restore` | clone the backup remote into the data dir; prompt for `--secret-key` (excluded from backups). **Build this — only a `git clone` comment exists today** |
| `auth status\|reset-password\|disable` | `the-librarian auth …` | dashboard-login lockout recovery from the host shell; works even when the UI is locked |
| `rebuild` | `the-librarian rebuild` | regenerate the disposable in-memory recall index from the vault |

**Dropped / not folded in:**
- `seed` — empty-store dev bootstrap; not an operator need.
- `migrate-data-dir` — not a user verb; `update` runs it automatically (§8).
- `export`, `handoffs` — exist in `@librarian/cli` but stay out of the curated
  `server admin` set (export is a power-user data dump; handoffs are managed via
  the dashboard / MCP). Still reachable via raw `docker exec` if ever needed.

**Mechanism.** Verified: the all-in-one image does **not** include `@librarian/cli`
at runtime — its `package.json` is copied into the *builder* for the install
layer, but the CLI is never built and never copied into the runtime stage
(`docker/all-in-one.Dockerfile:22, 34, 63-79`). So:
- Add `@librarian/cli` (built `dist` + bin) to `all-in-one.Dockerfile`'s runtime
  tree, with `the-librarian` on `PATH`.
- `server admin <cmd>` runs `docker exec the-librarian the-librarian <cmd>` — one
  uniform mechanism with direct data-dir access. This is what lets `auth`
  recovery bypass the (possibly-locked) dashboard, and lets `backup`/`restore`
  reuse the store + settings rather than re-implementing them.

## 8. Versioning & updates

- **Resolve-ref.** Default = the latest `vX.Y.Z` GitHub release tag (reuse
  `fetchLatestVersion` from `installer-cli/src/status.ts` + `compareVersions`/
  `isBehind` from `semver.ts`). `--ref` pins an explicit tag or `main`.
- **`server update`** = fetch tags → checkout the resolved ref → rebuild the
  image → recreate the container (volume preserved) → **run pending data-dir
  migrations** (`docker exec the-librarian the-librarian migrate-data-dir` —
  server boot only *warns* about pending migrations, it doesn't apply them:
  `packages/cli/src/commands/migrate-data-dir.ts`) → wait for health. Idempotent:
  already at the ref + healthy → a clean no-op. This is a cleaned-up, tag-pinned
  successor to `pull-and-restart.sh` (the stash/branch dance is dropped — the CLI
  owns its deploy dir).
- **`server status`** shows: container running?, health, the **deployed version**
  (checked-out tag), the **latest release**, and an `up-to-date | update-available`
  badge — the same comparison the dashboard's Phase-2 Installs view uses, applied
  to the server itself.

## 9. Boot persistence

- **Linux (systemd).** Generate a `the-librarian.service` unit whose `ExecStart`
  is `docker start --attach the-librarian` (referencing the **existing** named
  container created by `up`/`update`) and `ExecStop` is `docker stop`;
  `enable --now`. We deliberately do **not** bake the resolved `docker run` into
  `ExecStart`: that would write `-e LIBRARIAN_AGENT_TOKEN=…` into a
  world-readable `/etc/systemd/system/*.service` file — a leak. The container
  already carries its env (incl. the token) in Docker's own state, so referencing
  it by name keeps **no secret in the unit file**, and it survives `update`
  (which recreates the same container name). `--attach` keeps the container in the
  foreground so systemd's `Type=simple` supervision + `Restart=always` work.
  Idempotent; `disable-boot` reverses it. (Today's host unit is ad-hoc — this
  makes it reproducible.) See Open Question 3 for user-unit vs system-unit default.
- **macOS (launchd).** Deferred for v1: `up` notes that boot persistence is
  Linux-only for now and skips it cleanly. A follow-up adds a `launchd` plist.

## 10. Structure / stack / testing

- New module group under `packages/installer-cli/src/server/`: `up.ts`,
  `update.ts`, `down.ts`, `status.ts`, `logs.ts`, `boot.ts`, `admin.ts`, plus a
  `docker.ts` seam wrapping `docker`/`git` invocations (mirrors the existing
  `exec.ts`/`setRunner` injection so tests never touch a real daemon).
- Reuse existing infra: `semver.ts` (`compareVersions`/`isBehind`),
  `status.ts` (`fetchLatestVersion`/`setLatestFetcher`), `prompt.ts`
  (`createPrompter`), `paths.ts` (`librarianDir`/`envFilePath`/`setHomeOverride`),
  `exec.ts` (`run`/`which`/`setRunner`).
- `all-in-one.Dockerfile` gains the `@librarian/cli` runtime tree (§7).
- **Vitest**, same pattern as the harness modules: a fake runner asserts the
  exact `docker`/`git` argv for each command; `up` rollback on a failed health
  wait; `up` localhost vs `--host` argv difference (the `ALLOW_NO_AUTH` flag);
  `update` no-op when already at ref; `status` table from stubbed `docker inspect`
  + stubbed latest-release; `admin` dispatch builds the right `docker exec`. No
  test starts a real container.

## 11. Scope boundaries

**In scope (v1):** the `server` group (`up`/`update`/`down`/`status`/`logs`/
`enable-boot`/`disable-boot`/`admin`); all-in-one container only; latest-tag
deploy with `--ref` escape hatch; Linux systemd boot persistence; bundling
`@librarian/cli` + the new `the-librarian restore`.

**Out of scope — deferred (§15).** Prebuilt GHCR image; macOS launchd;
compose-via-CLI; k8s / fly.io / bare-metal / Windows; multi-host tracking.

**Operating boundaries:**
- **Always:** idempotent operations; preflight every external tool with a
  teaching error; never leave a half-up deploy (roll the container back on a
  failed `up`); the data volume is sacred across `update`/`down`; one change per
  PR with version bump + CHANGELOG + tests.
- **Ask first:** reusing/overwriting a deploy dir we didn't create; binding
  beyond `127.0.0.1` (and `0.0.0.0` especially); writing this machine's
  `~/.librarian/env` during `up`.
- **Never:** print or persist the master key / admin token to a file or log
  (one-time terminal surfacing only); deploy `0.0.0.0` by default; run the server
  outside Docker; expose `seed`/`migrate-data-dir` as routine verbs.

## 12. Key decisions

Locked by the owner (2026-06-13) unless marked *grounded* (an inference from the
verified code, surfaced for confirmation):

1. **All-in-one container only.** The two-container compose
   (`docker/docker-compose.yml`) stays a manual/advanced path the CLI does not
   drive.
2. **Latest released tag by default**, `--ref <tag|main>` escape hatch; `update`
   re-pins forward. Pinning = reproducibility, not freezing.
3. **Server self-generates** the master key (always) + admin token (beyond
   localhost); the CLI surfaces them once and never persists them; the CLI mints
   the **agent token** as the loop-closer; dashboard owner login is configured in
   the dashboard wizard, not prompted.
4. **Admin fold-in:** keep `backup`/`restore`/`auth`/`rebuild`; drop `seed`;
   `migrate-data-dir` runs inside `update`, not as a verb.
5. **Boot persistence:** opt-in during `up` + standalone `enable-boot`/
   `disable-boot` (Linux systemd); macOS deferred.
6. **Single-instance per host;** `server status` is host-local (no machine-id).
7. *(grounded)* **Localhost vs beyond-localhost auth is driven by
   `LIBRARIAN_ALLOW_NO_AUTH`** (§6), because the container always binds
   `0.0.0.0` internally and can't see the host publish address.
8. *(grounded)* **`update` applies migrations via `docker exec … migrate-data-dir`**,
   because server boot only warns about pending migrations.
9. *(grounded)* **The image genuinely lacks `@librarian/cli` at runtime today**
   (only its `package.json` is copied into the builder), so bundling it is real
   new work, not a no-op.

## 13. Open questions

1. **`ALLOW_NO_AUTH` scope.** Does `LIBRARIAN_ALLOW_NO_AUTH=true` disable
   agent-token enforcement on `/mcp` as well as admin/dashboard enforcement? If
   it disables `/mcp` auth too, the minted agent token on a localhost-only
   install is forward-compatibility sugar (it becomes enforced once the operator
   rebinds beyond localhost). Confirm before building success criterion 3;
   `sdlc-implement` pins the answer with a test.
2. **Tailscale detection.** Offer the tailnet IP by detecting `tailscale ip -4`,
   or rely on explicit `--host` only in v1?
3. **systemd unit default.** User unit (`~/.config/systemd/user/`, needs
   `loginctl enable-linger` to survive logout) vs system unit
   (`/etc/systemd/system/`, needs `sudo` but reliably boots). Which is the
   default, and does `--system` switch it?
4. **Deploy-dir co-location.** Confirm `~/.librarian/server` (server state) as a
   sibling of `~/.librarian/env` (client config) is acceptable, given §3 keeps
   them logically distinct.

## 14. Task plan

Ordered by dependency; each slice is vertical (it leaves the system working and
testable) and carries its own acceptance check. Riskiest slices (S2, S7) are early.

- [ ] **S1 — `server` group skeleton + seam + preflight.**
      *Accept:* `librarian server` (no subcommand) prints the surface;
      `librarian --help` shows both groups; preflight emits a teaching error when
      `docker`/`git` is missing (stubbed `which`). No real daemon touched.
      *Depends:* none.
- [ ] **S2 — `up` happy path (localhost).** Clone-at-latest-tag → build → run
      (named volume, `ALLOW_NO_AUTH=true`, minted agent token) → health-wait +
      rollback → surface master key once → print MCP/dashboard URL + agent token
      → optional local `~/.librarian/env`.
      *Accept:* fake runner asserts the exact `git clone`/`docker build`/
      `docker run` argv; a failed health-wait removes the container (no half-up);
      master key surfaced once, written to no host file. (SC 1, 2.)
      *Depends:* S1.
- [ ] **S3 — beyond-localhost binding + admin-token surfacing.**
      *Accept:* `up --host <ip>` omits `ALLOW_NO_AUTH`, binds `-p <ip>:…`, reads
      `/data/admin.token` via `docker exec` after health and surfaces it once;
      `0.0.0.0` is ask-first. (SC 3.)
      *Depends:* S2.
- [ ] **S4 — `down` / `logs` / `status`.**
      *Accept:* `down` argv is `docker stop` only (never `rm -v`/`volume rm`);
      `logs [-f] [--service]` maps to `docker logs`; `status` renders running/
      health/deployed-vs-latest badge from stubbed `docker inspect` + stubbed
      `fetchLatestVersion`. (SC 4, 6.)
      *Depends:* S2.
- [ ] **S5 — `update` (re-pin + rebuild + recreate + migrate), idempotent.**
      *Accept:* upgrade argv sequence (fetch tags → checkout newest → build →
      recreate preserving volume → `docker exec … migrate-data-dir` → health);
      already-at-latest + healthy → no-op (no build/run argv). (SC 5.)
      *Depends:* S2, S4.
- [ ] **S6 — boot persistence (systemd; macOS deferred).**
      *Accept:* `enable-boot`/`up --enable-boot` writes the unit (`ExecStart` =
      `docker start --attach the-librarian` — the existing named container, no
      secret in the file), `enable --now`, idempotent; `disable-boot`
      reverses; macOS prints the deferred notice + skips. (SC 7.)
      *Depends:* S2.
- [ ] **S7 — bundle `@librarian/cli` + `admin` dispatch + build `restore`.**
      *Accept:* the built all-in-one image has `the-librarian` on `PATH`
      (integration check); `server admin <verb>` → `docker exec the-librarian
      the-librarian <verb>` argv; new `the-librarian restore` clones the backup
      remote into the data dir, accepts/prompts `--secret-key`, server decrypts
      restored secrets; `auth reset-password` works against a locked dashboard.
      (SC 8, 9.)
      *Depends:* S2.
- [ ] **S8 — docs.** `DEPLOYMENT.md` "one-command self-host" section + README
      server blurb, matching the shipped surface.
      *Accept:* both document the real `server` surface (`up`→token→clients).
      *Depends:* S2–S7.
- [ ] **S9 — release gate.**
      *Accept:* `pnpm test`/`typecheck`/`lint` green; `check:release` green; root
      version bump + dated CHANGELOG entry; PR opened (never pushed to main).
      (SC 10.) *Depends:* all.

## 15. Deferred (explicitly out of scope for v1)

- Prebuilt image distribution (publish the all-in-one image to GHCR on release so
  `up` can `docker run` a tag without `git clone` + local build) — a natural
  follow-up to the npm auto-publish; removes the git/build dependency from `up`.
- macOS `launchd` boot persistence.
- The two-container compose path under the CLI (stays manual/advanced).
- k8s / fly.io / bare-metal / Windows (stay in `DEPLOYMENT.md`).
- Multi-host: the server is single-instance per host; `server status` is
  host-local. Tracking several *client* machines is the dashboard's Phase-2
  Installs view — distinct from the server, which needs no machine-id treatment.
