---
title: Manual deployment
description: Run The Librarian by hand with Docker — single container, Compose, or Fly.io.
---

The [one-command self-host](/deploy-and-operate/self-host/) path covers most people.
This page is for operators who want to drive Docker themselves: a hand-run single
container, the two-container Compose stack, or Fly.io.

## Single container (manual)

One image runs both services (the MCP server and the dashboard) under a small
supervisor. This is what `librarian server up` automates; run it by hand when you
want full control of the invocation:

```sh
docker build -f docker/all-in-one.Dockerfile -t the-librarian .
docker run -d --name the-librarian \
  -p 3042:3000 -p 3838:3838 \
  -v librarian_data:/data \
  -e LIBRARIAN_AGENT_TOKEN="$(openssl rand -base64 48)" \
  -e LIBRARIAN_SECRET_KEY="$(openssl rand -hex 32)" \
  the-librarian
```

Key points:

- The dashboard is at `http://<host>:3042` (the host side of `-p 3042:3000` —
  the container always listens on 3000 internally); the MCP endpoint is
  `http://<host>:3838/mcp`.
- `/data` is your vault and settings — **back it up** (see
  [Backups & restore](/guides/backups-restore/)). It must be writable by the image's
  user (UID 1000); on platforms that mount volumes root-owned, `chown` it.
- **There is no admin token.** The admin API runs only on an internal listener inside
  the container; the published port carries only the agent surface, gated by
  `LIBRARIAN_AGENT_TOKEN`. (More on this model in
  [Authentication & secrets](/deploy-and-operate/auth-and-secrets/).)
- **The master key auto-generates if unset.** On first boot the server writes it to
  `/data/secret.key` and logs it **once** — copy it somewhere safe. Supplying it via
  the environment (as above) is the recommended posture, because an env-supplied key
  is never written to the data volume. A 32-byte hex key (`openssl rand -hex 32`) is
  what the secret key wants — not the base64 value used for tokens.
- Put the published port behind **TLS** on any host reachable beyond loopback, and do
  not set `LIBRARIAN_ALLOW_NO_AUTH=true` on a publicly reachable host.
- The image crash-fasts if either service dies, so your orchestrator restarts the
  pair.

### Fly.io

A starter `fly.toml` is included. Edit `app` and `primary_region`, then:

```sh
fly volumes create librarian_data --size 1
fly secrets set LIBRARIAN_AGENT_TOKEN=… LIBRARIAN_SECRET_KEY=…
fly deploy
```

## Two-container Compose stack (advanced)

The Compose stack runs two Node services — `mcp-server` (the agent surface on the
published port 3838, plus the admin API on a separate **unpublished** internal port)
and `dashboard` (the Next.js admin UI on port 3000) — sharing one named volume.

Copy the repository to your host, create an env file, and set an agent token (the one
network credential):

```sh
cp .env.example .env
openssl rand -base64 48              # generate an agent token
```

Put it in `.env`:

```sh
LIBRARIAN_AGENT_TOKEN=<long-random-agent-token>
```

There is **no admin token** to set. The master key (`LIBRARIAN_SECRET_KEY`) is
optional — it auto-generates if unset; set it to keep the key off the data volume.
If you want each agent's writes attributed to a distinct identity, use per-agent
tokens:

```sh
LIBRARIAN_AGENT_TOKENS=codex:<token-a>,claude:<token-b>
```

By default both services bind to `127.0.0.1` only. For tailnet access, set the
published hosts:

```sh
LIBRARIAN_MCP_PUBLISHED_HOST=100.x.y.z
LIBRARIAN_DASHBOARD_PUBLISHED_HOST=100.x.y.z
```

Build and start, then verify:

```sh
docker compose --env-file .env -f docker/docker-compose.yml up -d --build

curl http://100.x.y.z:3838/healthz
curl http://100.x.y.z:3839/health
```

(If the dashboard health check fails the first time, give it ~15 seconds — Next.js
cold-boots slower than the MCP server. If you see `permission denied` under `/data`,
stop the stack, `chown -R 1000:1000` the volume's data directory, and start again.)

## Endpoints

- **Dashboard:** `http://<host>:3042/` (single-container default; the Compose
  stack above publishes it on `:3839` instead)
- **MCP endpoint:** `http://<host>:3838/mcp` — agents POST JSON-RPC here with an
  `Authorization: Bearer <token>` header.
- **Healthcheck:** `http://<host>:3838/healthz`
- **Primer:** `http://<host>:3838/primer.md` — the agent briefing, served **without
  authentication** by design so tools like OpenCode can load it from a URL. It is the
  only unauthenticated route; keep the briefing generic (never secret) content.

Treat dashboard network access as admin access, and keep the published host on a
private network. If you front the dashboard with a reverse proxy on another hostname,
add that exact origin to `LIBRARIAN_ALLOWED_ORIGINS`.

## Day-to-day operations

```sh
# View logs
docker compose --env-file .env -f docker/docker-compose.yml logs -f

# Upgrade
git pull
docker compose --env-file .env -f docker/docker-compose.yml up -d --build

# Stop
docker compose --env-file .env -f docker/docker-compose.yml down
```

Keep the data volume on local disk, not NFS or another unreliable network
filesystem, and push vault backups off-server. Stopping with `down -v` **wipes the
data volume** — only do that when you mean to destroy everything.
