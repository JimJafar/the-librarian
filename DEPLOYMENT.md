# Deploying The Librarian

This deployment is designed for a low-traffic personal VPS or a remote host.

## Single container (recommended)

One image runs both services under `tini` (PID 1) → a small supervisor → the MCP
server + the dashboard. The lowest-friction way to self-host:

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
- `/data` is a named volume (your memories + sessions) — back it up (see the README's Backup section). It must be **writable by UID 1000** (the image's `node` user); on platforms that mount volumes root-owned, `chown` it.
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
  - `mcp-server` — JSON-RPC at `/mcp`, admin tRPC at `/trpc/*`, liveness at `/healthz`. Port 3838.
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

Treat dashboard network access as admin access — the dashboard process holds the admin token. Keep the published host private to your Tailnet (or other trusted network).

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

## Adding the MCP server

### To Hermes Agent

`hermes mcp add librarian --url http://<vps-tailscale-ip>:3838/mcp`

Or add the following to your `.hermes/config.yaml`:

```yaml
mcp_servers:
  the_librarian:
    url: "http://<vps-tailscale-ip>:3838/mcp"
    headers:
      Authorization: "Bearer ***"
```

Check it with `hermes mcp test the_librarian`

There is no bundled "how to use The Librarian" skill to preload (ADR 0006) — the
primer (`vault/primer.md`, served at connect time via the MCP `initialize`
`instructions` field and `GET /primer.md`) plus each MCP tool's description are
the teaching surface.
