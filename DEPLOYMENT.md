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
- `/data` is a named volume (your memories + sessions) — back it up (see the README's Backup section).
- `LIBRARIAN_SECRET_KEY` is optional but **required to save curator config** (it encrypts the curator's LLM token at rest); generate with `openssl rand -hex 32` — a 32-byte key, not the base64-48 used for tokens.
- The MCP port is exposed for remote agents; it requires a bearer token and should sit behind TLS (a reverse proxy) for anything beyond a private network.
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
- Append-only JSONL ledgers in `/data/events.jsonl` and `/data/sessions.jsonl`. Rebuildable SQLite + FTS5 index at `/data/librarian.sqlite`.

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

If you want `agent_private` memories to be enforced between agents, use per-agent tokens (each pinned to a single `agent_id`):

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

The `--remote` mode skips the in-process JSONL/SQLite/lifecycle checks and only probes `/healthz` reachability + `/mcp` auth against the running compose stack. The `--agent-token` flag accepts either the agent or admin token.

If the dashboard health check fails first time, give it ~15 seconds to start — Next.js cold boot is slower than the mcp-server.

If you see `permission denied, open '/data/events.jsonl'` on the mcp-server:

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

Use the shared `LIBRARIAN_AGENT_TOKEN` for ordinary agent requests, or a per-agent token from `LIBRARIAN_AGENT_TOKENS` to enforce one agent identity. Admin-only MCP tools (proposal approval, deletion, conflict resolution) require the admin token.

The HTTP endpoint supports JSON-RPC POST and batches. It is suitable for low-traffic agent use but is not a full Streamable HTTP MCP transport. Stdio MCP remains available locally via `pnpm start`.

## Origin checks

Same-origin browser requests are allowed by default. If you front the dashboard with an HTTPS reverse proxy or alternate hostname, add the exact origin(s) to `.env`:

```sh
LIBRARIAN_ALLOWED_ORIGINS=https://librarian.example.com
docker compose --env-file .env -f docker/docker-compose.yml up -d
```

## Backups

Back up `events.jsonl` and `sessions.jsonl` first. They are the canonical source of truth. `librarian.sqlite` and `memories.md` can be rebuilt.

The volume is named `librarian_data`. Inspect its mount path with `docker volume inspect librarian_data` (typically `/var/lib/docker/volumes/librarian_data/_data` on Linux hosts).

Simple daily backup example:

```sh
mkdir -p ~/librarian-backups
docker run --rm -v librarian_data:/data -v ~/librarian-backups:/backup busybox \
  tar -czf /backup/librarian-$(date +%Y-%m-%d).tar.gz \
  /data/events.jsonl /data/sessions.jsonl /data/memories.md
```

### Rebuild from JSONL after a SQLite wipe

The SQLite file is a projection; deleting it is recoverable. The mcp-server rebuilds the projection automatically on startup if `librarian.sqlite` is missing. So the recovery sequence is:

```sh
docker compose --env-file .env -f docker/docker-compose.yml down
docker run --rm -v librarian_data:/data busybox rm -f /data/librarian.sqlite
docker compose --env-file .env -f docker/docker-compose.yml up -d
```

The next boot replays `events.jsonl` and `sessions.jsonl` into a fresh `librarian.sqlite`. Check the logs (`docker compose ... logs mcp-server`) for the projection-rebuild line.

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

Do not put the data volume on NFS or another unreliable network filesystem. Keep the active SQLite file on local disk and back the JSONL ledgers up off-server.

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

Make the skill auto-load: `hermes config set skills.preloaded "use-the-librarian,<some-other-skill>"`
