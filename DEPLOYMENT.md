# Deploying The Librarian

This deployment is designed for a low-traffic personal VPS in a Tailnet.

## Shape

- One Node process
- One persistent data directory
- HTTP dashboard at `/`
- MCP JSON-RPC endpoint at `/mcp`
- Healthcheck at `/healthz`
- Separate admin and agent token authentication
- Append-only JSONL ledger in `/data/events.jsonl`
- Rebuildable SQLite index in `/data/librarian.sqlite`

## VPS Setup

Copy the repository to the VPS, then create an env file:

```sh
cp .env.example .env
```

Generate two tokens:

```sh
openssl rand -base64 48
```

Set both tokens in `.env`:

```sh
LIBRARIAN_ADMIN_TOKEN=<long-random-admin-token>
LIBRARIAN_AGENT_TOKEN=<different-long-random-agent-token>
```

Use the admin token for the dashboard and administrative API calls. Use the agent token for normal agent access to `/mcp`.

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

Open the dashboard:

```text
http://100.x.y.z:3838/
```

Use any username and the admin token as the password when the browser prompts for Basic auth.

## MCP Endpoint

Agents should send JSON-RPC MCP-compatible requests to:

```text
http://100.x.y.z:3838/mcp
```

Use:

```http
Authorization: Bearer <LIBRARIAN_AGENT_TOKEN>
```

Use `LIBRARIAN_AGENT_TOKEN` for ordinary agent requests. Admin-only MCP tools, such as proposal approval, deletion, and conflict resolution, require the admin token.

The HTTP endpoint supports simple JSON-RPC POST requests and JSON-RPC batches. It is suitable for low-traffic agent use, but it is not a full Streamable HTTP MCP transport implementation. Stdio MCP remains available through `npm start` for local clients that launch the server as a subprocess.

## Origin Checks

If browser POST requests are blocked by Origin validation, add the dashboard origin to `.env`:

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
docker compose run --rm librarian node --no-warnings src/cli.js rebuild
```

## Operations

View logs:

```sh
docker compose logs -f librarian
```

Upgrade:

```sh
git pull
docker compose up -d --build
```

Stop:

```sh
docker compose down
```

Do not put `data/` on an NFS or other unreliable network filesystem. Keep the active database on local disk and back it up off-server.
