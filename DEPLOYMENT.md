# Deploying The Librarian

This deployment is designed for a low-traffic personal VPS or a remote host.

## One-command self-host (`librarian server`)

The lowest-friction path. The `librarian` CLI drives the all-in-one container
end to end: it builds and runs the image, manages the data volume, surfaces the
secrets, and hands you the MCP URL + agent token to paste into clients. You never
hand-write a `docker run` or an `.env` for the happy path.

```sh
npm i -g @the-librarian/cli
librarian server up
```

`server up` (on a host with Docker + git):

1. Clones the monorepo at the latest release tag into `~/.librarian/server`
   (the deploy dir; `--dir` overrides) and builds `the-librarian:<tag>`.
2. Runs the all-in-one container (named `the-librarian`) on the named data volume
   `librarian_data` (`--data-volume` overrides), waits for **both** services to
   report healthy, and rolls the container back if they don't (the data volume is
   never touched).
3. Surfaces, **once**, the server-generated **master key** with a
   `SAVE THIS KEY — excluded from backups` warning. It is read back from
   `/data/secret.key` and written to **no** host file or log — copy it now or you
   cannot decrypt restored backups later.
4. Prints the **MCP URL** (`http://<host>:3838/mcp`), the dashboard URL
   (`http://<host>:3000`), and a freshly minted **agent token**. Paste the MCP URL
   + agent token into `librarian install` (or `librarian config --mcp-url <url>
   --token <token>`) on each client.
5. Offers to write **this** machine's own `~/.librarian/env` (single-box dev gets
   server + client in one shot) — offer, never force.

### Bind host (`--host`)

The default bind is `127.0.0.1` (host loopback only) — the server is reachable
only from the machine it runs on, and runs with the localhost no-auth bypass (no
admin token is generated). To reach it from elsewhere, choose a bind:

- `--host <tailnet-ip>` — bind a specific reachable address (e.g. a Tailscale
  IP). An interactive `up` with no `--host` **offers** a detected Tailscale
  address; it never binds beyond localhost without your say-so.
- `--host 0.0.0.0` — bind **all** interfaces. This is **ask-first**: a plain `up`
  prompts before exposing every interface (`--yes` auto-accepts). `0.0.0.0` is a
  bind directive, not a connectable address — point clients at the machine's real
  LAN/tailnet IP.

When bound **beyond** localhost the server generates and enforces an **admin
token** (`/data/admin.token`), which `up` also surfaces once — paste it into the
dashboard's auth wizard, or use it with `server admin auth`. Put port 3838 behind
**TLS** (a reverse proxy) on any host reachable beyond loopback.

### Pinning and updates

- `--ref <tag|main>` pins `up`/`update` to an explicit release tag or `main`
  (default: the latest release tag). Pinning is reproducibility, not freezing.
- `librarian server update` re-pins **forward**: fetch tags → checkout the
  resolved ref → rebuild → recreate the container (the `librarian_data` volume is
  **preserved**) → apply pending data-dir migrations → wait for health. It is
  **idempotent**: already at the resolved ref and healthy → a clean no-op. The
  existing agent token is read back from the running container and reused, so
  clients keep working with no action (only if it can't be read does `update`
  mint and surface a fresh one).
- `librarian server down` stops the container with `docker stop` only — it
  **never** removes the container or the volume. The data is kept; a later `up`
  or `update` recalls the same memories.
- `librarian server status` reports running?, health, the deployed version, the
  latest release, and an `up-to-date | update-available` badge (degrades to
  `unknown`/`?` offline, never crashes).
- `librarian server logs [-f] [--service mcp|dashboard|all]` tails the container
  logs. `-f` follows live; `--service` filters the combined stream to the MCP
  server (`mcp`), the dashboard (`dashboard`), or both (`all`, the default).

### Boot persistence (Linux)

- `librarian server enable-boot` (or `librarian server up --enable-boot`)
  installs and enables a `the-librarian.service` systemd unit so the container
  starts on boot. The unit references the **existing** named container
  (`ExecStart=docker start --attach the-librarian`) and carries **no secret** —
  the agent token is never written into the world-readable unit file. It survives
  `server update` (the container name is stable).
- `librarian server disable-boot` reverses it (disables + removes the unit,
  reloads systemd; the container itself is untouched).
- **macOS** boot persistence is deferred — these commands print a "Linux-only for
  now" notice and skip cleanly; start the server manually with `server up`.

### Admin from the host (`server admin`)

`librarian server admin <backup|restore|auth|rebuild> [args…]` runs the bundled
admin CLI **inside** the container (`docker exec the-librarian the-librarian
<verb> …`). Because it runs in the container against the live data dir, it works
**even when the dashboard is locked** — which is exactly what makes `auth`
recovery and `backup`/`restore` reliable.

- `backup` — push the vault to the configured GitHub backup remote.
- `restore` — clone the backup remote back into the data dir. It needs the
  master key via `--secret-key <hex>` (the key is **excluded from backups** by
  design, so it must be re-supplied; an interactive run prompts for it, no-echo).
  Use `--force` to replace a populated vault. This is the inverse of `backup`.
- `auth status | reset-password | disable` — recover dashboard login from the
  host shell (clear a lockout, set a new password) without the UI.
- `rebuild` — regenerate the disposable in-memory recall index from the vault.

`seed`, `migrate-data-dir`, `export`, and `handoffs` are deliberately **not**
folded in (`migrate-data-dir` runs automatically on `update`; the rest are
dev/dashboard surfaces). They remain reachable via a raw `docker exec` if ever
needed.

### What `server` does NOT drive

`librarian server` manages the **all-in-one** container only. The two-container
Compose stack (below) stays the **manual/advanced** path the CLI does not drive —
use it when you want the split mcp-server + dashboard processes or
Compose-native operations.

## Single container — manual

One image runs both services under `tini` (PID 1) → a small supervisor → the MCP
server + the dashboard. This is what `librarian server up` automates above; run
it by hand when you want full control of the `docker run` invocation:

```sh
docker build -f docker/all-in-one.Dockerfile -t the-librarian .
docker run -d --name the-librarian \
  -p 3000:3000 -p 3838:3838 \
  -v librarian_data:/data \
  -e LIBRARIAN_ADMIN_TOKEN="$(openssl rand -base64 48)" \
  -e LIBRARIAN_AGENT_TOKEN="$(openssl rand -base64 48)" \
  -e LIBRARIAN_SECRET_KEY="$(openssl rand -hex 32)" \
  the-librarian
```

- Dashboard → `http://<host>:3000`; MCP endpoint → `http://<host>:3838/mcp`.
- `/data` is a named volume (your vault + settings) — back it up (see Backups below). It must be **writable by UID 1000** (the image's `node` user); on platforms that mount volumes root-owned, `chown` it.
- **Credentials auto-generate if unset.** Both `LIBRARIAN_SECRET_KEY` and `LIBRARIAN_ADMIN_TOKEN` are optional: on first boot, if unset, the server writes them to the data volume (`/data/secret.key` and — only when bound beyond localhost — `/data/admin.token`, both mode `0600`) and logs each **once**. So a fresh install needs **zero** secret/auth env vars; the commands above set them explicitly only if you'd rather manage the values yourself (env always wins over the generated files). Watch the boot log on first run:
  - **`Generated a new master key … SAVE THIS KEY`** — copy `secret.key` somewhere safe. Without it, secrets (curator token) and restored backups can't be decrypted. The key is deliberately **excluded from backups**.
  - **`Generated a new admin token … : libadmin_…`** — copy it; it's printed only this once (the sole sanctioned token log). You'll paste it into the dashboard to enable auth, and into a separate dashboard container's `LIBRARIAN_ADMIN_TOKEN` if you run the two-container shape.
- `LIBRARIAN_SECRET_KEY` is **required to save curator config** (it encrypts the curator's LLM token at rest); set it with `openssl rand -hex 32` — a 32-byte key, not the base64-48 used for tokens — or let it auto-generate.
- **Port 3838 carries the admin tRPC API (`/trpc/*`) as well as `/mcp`.** When bound beyond localhost the server needs an admin token; it now **auto-provisions one** rather than refusing to start, but 3838 should still sit behind **TLS** (a reverse proxy). Do **not** set `LIBRARIAN_ALLOW_NO_AUTH=true` on a publicly-reachable host.
- The image runs `tini` as PID 1 (orphan reaping) and **crash-fasts** if either service dies, so your orchestrator restarts the pair.

### Fly.io

A starter [`fly.toml`](./fly.toml) is included. Edit `app` / `primary_region`, then:

```sh
fly volumes create librarian_data --size 1
fly secrets set LIBRARIAN_ADMIN_TOKEN=… LIBRARIAN_AGENT_TOKEN=… LIBRARIAN_SECRET_KEY=…
fly deploy
```

## Shape (two-container compose — advanced)

- Two Node services in a Docker Compose stack:
  - `mcp-server` — JSON-RPC at `/mcp`, admin tRPC at `/trpc/*`, liveness at `/healthz`, the agent primer at `GET /primer.md` (unauthenticated by design — see below). Port 3838.
  - `dashboard` — Next.js admin UI. Server Actions for writes, browser tRPC via a same-origin proxy. Port 3000.
- One persistent named volume (`librarian_data`) mounted at `/data` in the mcp-server.
- Token authentication on `/mcp` (bearer) and `/trpc/*` (admin). The admin token never leaves the dashboard server process.
- A git-backed markdown vault at `/data/vault` (memories, handoffs, references — every write is a commit) plus JSON sidecar files (settings, run bookkeeping) next to it. The recall index is in-memory and disposable, rebuilt from the vault.

Compose file: [`docker/docker-compose.yml`](./docker/docker-compose.yml). Both services build from the Dockerfiles in [`docker/`](./docker/).

## Compose stack

Copy the repository to the VPS, then create an env file from the template at the repo root:

```sh
cp .env.example .env
```

Generate two distinct tokens:

```sh
openssl rand -base64 48   # admin
openssl rand -base64 48   # agent
```

Set them in `.env`:

```sh
LIBRARIAN_ADMIN_TOKEN=<long-random-admin-token>
LIBRARIAN_AGENT_TOKEN=<different-long-random-agent-token>
```

`LIBRARIAN_ADMIN_TOKEN` is used for both administrative `/mcp` calls AND as the dashboard's server-side tRPC bearer. `LIBRARIAN_AGENT_TOKEN` is for normal agent `/mcp` traffic. The two must differ.

If you want each agent's writes attributed to a distinct `agent_id`, use per-agent tokens (each pinned to a single `agent_id`):

```sh
LIBRARIAN_AGENT_TOKENS=codex:<token-a>,claude:<token-b>
```

By default the host binds both services to `127.0.0.1` only. For Tailnet access, set the published hosts in `.env`:

```sh
LIBRARIAN_MCP_PUBLISHED_HOST=100.x.y.z
LIBRARIAN_DASHBOARD_PUBLISHED_HOST=100.x.y.z
```

Build and start the stack:

```sh
docker compose --env-file .env -f docker/docker-compose.yml up -d --build
```

Verify it's up:

```sh
curl http://100.x.y.z:3838/healthz
curl http://100.x.y.z:3000/health
pnpm run healthcheck -- --remote http://100.x.y.z:3838 --agent-token "$LIBRARIAN_AGENT_TOKEN"
```

The `--remote` mode skips the in-process checks and only probes `/healthz` reachability + `/mcp` auth against the running compose stack. The `--agent-token` flag accepts either the agent or admin token.

If the dashboard health check fails first time, give it ~15 seconds to start — Next.js cold boot is slower than the mcp-server.

If you see a `permission denied` error under `/data` on the mcp-server:

```sh
docker compose --env-file .env -f docker/docker-compose.yml down
sudo chown -R 1000:1000 /var/lib/docker/volumes/librarian_data/_data
docker compose --env-file .env -f docker/docker-compose.yml up -d
```

## URLs

- Dashboard: `http://<host>:3000/`
- MCP endpoint: `http://<host>:3838/mcp`
- Healthcheck: `http://<host>:3838/healthz`
- Primer: `http://<host>:3838/primer.md`

Treat dashboard network access as admin access — the dashboard process holds the admin token. Keep the published host private to your Tailnet (or other trusted network).

### The primer endpoint

`GET /primer.md` serves the agent primer (`vault/primer.md`) **without
authentication** — deliberately, so OpenCode's remote-URL `instructions`
config can load it with no token. The same text rides the MCP `initialize`
result's `instructions` field. It is the only unauthenticated content route;
all tRPC/admin routes stay token-gated. Keep the primer generic guidance —
never put operator-specific or secret content in it. Edit it from the
dashboard's **Vault** page (`/vault` → `primer.md`); the server enforces a
2 KB cap on save, and every save is a git commit you can diff and restore
from the file's history.

## MCP endpoint

Agents send JSON-RPC MCP requests to:

```text
http://<host>:3838/mcp
```

With:

```http
Authorization: Bearer <LIBRARIAN_AGENT_TOKEN>
```

**Preferred: mint per-agent tokens in the dashboard.** When auth is enabled, sign in and open **Tokens** (`/tokens`) to generate a token per agent and revoke them — these are stored (hashed) in the DB and take effect on `/mcp` immediately, with no restart. The plaintext is shown once; paste it into the client.

The env tokens still work and are the fallback when you don't run the dashboard: the shared `LIBRARIAN_AGENT_TOKEN` for ordinary agent requests, or a per-agent map in `LIBRARIAN_AGENT_TOKENS` (`agent_id:token,…`) to pin an identity. `LIBRARIAN_AGENT_TOKENS` is now **optional/legacy** — prefer dashboard-minted tokens. Admin-only MCP tools (proposal approval, deletion) require the admin token.

The HTTP endpoint supports JSON-RPC POST and batches. It is suitable for low-traffic agent use but is not a full Streamable HTTP MCP transport. Stdio MCP remains available locally via `pnpm start`.

## Origin checks

Same-origin browser requests are allowed by default. If you front the dashboard with an HTTPS reverse proxy or alternate hostname, add the exact origin(s) to `.env`:

```sh
LIBRARIAN_ALLOWED_ORIGINS=https://librarian.example.com
docker compose --env-file .env -f docker/docker-compose.yml up -d
```

## Dashboard login (single-owner)

The dashboard can require the owner to sign in instead of relying on a VPN/private
network. It is **off by default** and **recommended for any internet-exposed
deployment.** When enabled, every dashboard page redirects an unauthenticated
visitor to `/login`, and the same-origin `/api/trpc` proxy (which carries the admin
token) refuses requests without a session. Sessions are **JWT** (no DB session
store — the dashboard never opens the data store).

### Recommended: configure auth in the dashboard (no redeploy)

Open **`/settings/auth`** and use the wizard:

1. **Set a method** — a username + password (no GitHub/Google account required),
   and/or wire GitHub/Google OAuth (the wizard shows the exact callback URL to
   register and takes the client id/secret + your owner account id).
2. **Enable** — paste the **admin token** (auto-generated and printed once on first
   boot, or at `${LIBRARIAN_DATA_DIR}/admin.token`) into the "Enable authentication"
   card. Enforcement flips on immediately — no redeploy.

Config lives in the store, the JWT secret is derived from `LIBRARIAN_SECRET_KEY`
(nothing extra to set), and N wrong passwords trigger a lockout. **Recovery from the
host shell** if you lock yourself out or forget the password:

```sh
the-librarian auth status                      # what's configured (no secrets)
the-librarian auth reset-password              # set a new password (prompted), clears lockout
the-librarian auth reset-password --print-setup-link --origin https://librarian.example.com
the-librarian auth disable                     # break-glass: turn enforcement off
```

### Legacy: env-configured auth (deprecated)

Existing A1–A5 deployments can still configure auth entirely through env vars
(store config wins when present; otherwise these are the fallback). New installs
should prefer the wizard above. Configure in `.env`:

```sh
LIBRARIAN_AUTH_ENABLED=true
AUTH_SECRET=$(openssl rand -base64 33)      # signs the session JWT
AUTH_URL=https://librarian.example.com       # dashboard's public origin
AUTH_GITHUB_ID=…  AUTH_GITHUB_SECRET=…       # GitHub OAuth app
AUTH_GOOGLE_ID=…  AUTH_GOOGLE_SECRET=…       # (optional) Google OAuth client
# Allowlist the single owner — set at least one:
LIBRARIAN_OWNER_GITHUB_ID=1234567            # numeric id from api.github.com/users/<you>
LIBRARIAN_OWNER_GOOGLE_ID=…                  # the OIDC `sub`
LIBRARIAN_OWNER_EMAILS=you@example.com       # comma-separated; verified emails only (see below)
```

Register the OAuth app's callback URL as `<AUTH_URL>/api/auth/callback/github`
(and `…/google`). With no owner configured the allowlist **denies every login**
by design, so set an owner id before enabling the flag — otherwise you lock
yourself out.

> **Allowlist by account id, not email, on GitHub.** The email fallback is only
> honored for a provider-**verified** email. Google asserts verification, but
> GitHub does not — an OAuth profile email there is attacker-settable — so
> `LIBRARIAN_OWNER_EMAILS` is ignored for GitHub logins. Use
> `LIBRARIAN_OWNER_GITHUB_ID` for GitHub.

`trustHost: true` is set because the dashboard runs behind a proxy (Fly/Docker),
so it trusts the forwarded `Host` header — the proxy must be the only ingress.
`AUTH_URL` is set explicitly, which pins the OAuth callback origin regardless.

## Backups

**The vault IS the backed-up artifact.** Every write is a git commit, so a backup
is a `git push` of the vault to a private remote — no bundles, no snapshot dumps.
Restore is a `git clone` of that remote into a fresh data dir. The settings
sidecar (`settings.json`, secret values encrypted with `LIBRARIAN_SECRET_KEY`)
lives outside the vault — include it in a volume snapshot if you want settings
back without reconfiguring.

### Automated backups (dashboard **Backups** page)

The dashboard's **Backups** cockpit (admin) drives the whole lifecycle — no redeploy
to change the schedule.

- **Schedule**: enable scheduled backups and set the frequency (minutes). The
  server pushes the vault once the interval elapses; trigger one anytime with
  **Backup now**.
- **Target**: a GitHub repo (`owner/repo`) + a fine-grained **PAT** with
  **Contents: read/write** on that repo. Credentials are encrypted at rest with
  `LIBRARIAN_SECRET_KEY` and never leave the server; the push token travels via
  `GIT_ASKPASS`, never in a URL.
- **Failure alerts**: the cockpit shows the last successful backup and a banner on
  the most recent failure; set a webhook URL to also POST a generic-JSON alert.

### Volume snapshot (alternative)

A crash-consistent tarball of the data volume (or use your platform's volume snapshots, e.g. Fly):

```sh
docker run --rm -v librarian_data:/data -v ~/librarian-backups:/backup busybox \
  tar -czf /backup/librarian-$(date +%Y-%m-%d).tar.gz /data
```

### Rebuild the recall index

The recall index is in-memory and disposable — it rebuilds from the vault on
boot and after every write, so there is nothing to repair. `the-librarian
rebuild` forces a rebuild if you've edited the vault out-of-band.

## Operations

View logs:

```sh
docker compose --env-file .env -f docker/docker-compose.yml logs -f
```

Upgrade:

```sh
git pull
docker compose --env-file .env -f docker/docker-compose.yml up -d --build
```

Stop:

```sh
docker compose --env-file .env -f docker/docker-compose.yml down
```

Stop and wipe the data volume (destructive):

```sh
docker compose --env-file .env -f docker/docker-compose.yml down -v
```

Do not put the data volume on NFS or another unreliable network filesystem. Keep it on local disk and push vault backups off-server.

## Connecting harnesses

Each harness's exact config lives in its in-tree integration README:

- **Claude Code** — [`integrations/claude`](./integrations/claude): one MCP
  config block; the primer rides the MCP `instructions` field natively.
  Optional plugin adds four slash commands.
- **Codex** — [`integrations/codex`](./integrations/codex): one block in
  `~/.codex/config.toml`. No code.
- **OpenCode** — [`integrations/opencode`](./integrations/opencode): an MCP
  block plus one `instructions` line pointing at `https://<host>/primer.md`.
  No code.
- **Hermes** — [`integrations/hermes`](./integrations/hermes): a Python
  MemoryProvider proxying the 7 verbs and injecting the primer via
  `system_prompt_block()`. (A bare `hermes mcp add librarian --url …/mcp`
  also works for the tools, but Hermes doesn't render MCP `instructions`,
  so the provider is the full-parity path.)
- **Pi** — [`integrations/pi`](./integrations/pi): a Pi extension registering
  the 7 tools natively and injecting the primer at `before_agent_start`.

There is no bundled "how to use The Librarian" skill to preload (ADR 0006) — the
primer (`vault/primer.md`, served at connect time via the MCP `initialize`
`instructions` field and `GET /primer.md`) plus each MCP tool's description are
the teaching surface.
