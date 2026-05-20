# Deploying The Librarian

This deployment is designed for a low-traffic personal VPS in a Tailnet.

## Shape

- Two Node services: `mcp-server` (`/mcp` JSON-RPC, `/trpc/*` admin API, `/healthz`) and `dashboard` (Next.js UI at port 3000)
- One persistent data directory shared between them
- Token authentication on both `/mcp` and `/trpc/*`; the admin token never leaves the dashboard server process
- Append-only JSONL ledgers in `/data/events.jsonl` and `/data/sessions.jsonl`
- Rebuildable SQLite + FTS5 index in `/data/librarian.sqlite`

A docker-compose file under [`docker/`](./docker/) wires both services with a shared `data` volume — see "Compose stack" below.

## VPS Setup

Copy the repository to the VPS, then create an env file:

```sh
cp .env.example .env
```

Generate two tokens:

```sh
openssl rand -base64 48
```

Set the admin token and either a shared agent token or per-agent tokens in `.env`:

```sh
LIBRARIAN_ADMIN_TOKEN=<long-random-admin-token>
LIBRARIAN_AGENT_TOKEN=<different-long-random-agent-token>
```

Use the admin token for administrative MCP calls and as the dashboard's server-side token. Use the agent token for normal agent access to `/mcp`. The Next.js dashboard injects the admin token server-side; it never reaches the browser. Keep the dashboard host private to your Tailnet or another trusted network boundary.

If you want `agent_private` memories to be enforced between agents, use per-agent tokens instead of, or in addition to, the shared agent token:

```sh
LIBRARIAN_AGENT_TOKENS=codex:<long-random-codex-token>,claude:<long-random-claude-token>
```

When an agent authenticates with a mapped token, The Librarian pins MCP calls to that `agent_id` even if the request body claims a different one.

For private Tailnet access, set `LIBRARIAN_PUBLISHED_HOST` to the VPS Tailscale IP:

```sh
LIBRARIAN_PUBLISHED_HOST=100.x.y.z
```

Start the service:

```sh
docker compose up -d --build
```

Check health:

```sh
curl http://100.x.y.z:3838/healthz
```

If the health check fails:

```sh
docker logs the-librarian
```

If you are getting `permission denied, open '/data/events.jsonl'`:

```sh
sudo chown -R 1000:1000 data
sudo chmod -R u+rwX,go-rwx data
docker compose up -d --force-recreate
```

Open the dashboard:

```text
http://100.x.y.z:3000/
```

The dashboard does not prompt for a token. Treat network access to this URL as admin access — its server-side process holds the admin token and proxies tRPC calls to the mcp-server at port 3838.

## MCP Endpoint

Agents should send JSON-RPC MCP-compatible requests to:

```text
http://100.x.y.z:3838/mcp
```

Use:

```http
Authorization: Bearer <LIBRARIAN_AGENT_TOKEN>
```

Use `LIBRARIAN_AGENT_TOKEN` for ordinary shared agent requests, or use a token from `LIBRARIAN_AGENT_TOKENS` to enforce one agent identity. Admin-only MCP tools, such as proposal approval, deletion, and conflict resolution, require the admin token.

The HTTP endpoint supports simple JSON-RPC POST requests and JSON-RPC batches. It is suitable for low-traffic agent use, but it is not a full Streamable HTTP MCP transport implementation. Stdio MCP remains available through `npm start` for local clients that launch the server as a subprocess.

## Origin Checks

Same-origin browser requests are allowed by default. If browser POST requests are blocked because you are using an HTTPS reverse proxy or alternate hostname, add the dashboard origin to `.env`:

```sh
LIBRARIAN_ALLOWED_ORIGINS=http://100.x.y.z:3838
```

Restart:

```sh
docker compose up -d
```

## Backups

Back up `./data/events.jsonl` first. It is the canonical source of truth. `librarian.sqlite` and `memories.md` can be rebuilt.

Simple daily backup example:

```sh
mkdir -p ~/librarian-backups
tar -czf ~/librarian-backups/librarian-$(date +%Y-%m-%d).tar.gz data/events.jsonl data/memories.md
```

After restoring `events.jsonl`, rebuild the index:

```sh
docker compose -f docker/docker-compose.yml run --rm mcp-server pnpm run rebuild
```

## Operations

View logs:

```sh
docker compose -f docker/docker-compose.yml logs -f
```

Upgrade:

```sh
git pull
docker compose -f docker/docker-compose.yml up -d --build
```

Stop:

```sh
docker compose -f docker/docker-compose.yml down
```

Do not put `data/` on an NFS or other unreliable network filesystem. Keep the active database on local disk and back it up off-server.

## Adding the MCP server

### To Hermes Agent

`hermes mcp add librarian --url http://<vps-tailscale-ip>:<port>/mcp`

Or add the following to your `.hermes/config.yaml`:

```yaml
mcp_servers:
  the_librarian:
    url: "http://<vps-tailscale-ip>:<port>/mcp"
    headers:
      Authorization: "Bearer ***"
```

Check it with `hermes mcp test the_librarian`

Make the skill auto-load: `hermes config set skills.preloaded "use-the-librarian,<some-other-skill>"`
