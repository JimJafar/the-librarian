---
title: Self-host
description: Run and operate your own Librarian server with the one-command CLI.
---

The Librarian runs as one small self-hosted server. The lowest-friction way to run
it is the `librarian server` command group, which drives an all-in-one Docker
container end to end — it builds the image, manages your data, mints your secrets,
waits for health, and prints the values you paste into clients. You never hand-write
a `docker run` for the happy path.

This page is the operator reference. If you just want to get started, the gentler
[Install](/start-here/install/) walkthrough is the place to begin. Prefer to drive
Docker yourself? See [Manual deployment](/deploy-and-operate/manual-install/).

## Standing it up

On a host with Docker and Git:

```sh
npx @the-librarian/cli server up
```

`server up` does the following:

1. **Clones and builds.** It fetches the project at the latest release into a deploy
   directory (`~/.librarian/server` by default; `--dir` overrides) and builds the
   container image.
2. **Runs and health-checks.** It starts the all-in-one container on a named data
   volume (`librarian_data`), waits for **both** the MCP server and the dashboard to
   report healthy, and rolls back if they don't — your data volume is never touched
   on a failed start.
3. **Mints the master key.** It generates the master key and writes it, with the
   agent token, into a `0600` env-file kept **off** the data volume, then runs the
   container from that file. The key is shown **once** with a `SAVE THIS KEY`
   warning. Copy it now — it is excluded from backups, so without it you cannot
   decrypt a restored backup later.
4. **Prints the connection details.** The MCP URL (`http://<host>:3838/mcp`), the
   dashboard URL (`http://<host>:3000`), and a fresh agent token. Paste the MCP URL
   and token into `librarian install` on each client.
5. **Optionally configures this machine.** It offers to write this box's own client
   config, so a single-machine setup is done in one shot.

:::caution[Use native Docker, not the snap package]
`librarian server` requires **native Docker** (Docker CE / `docker.io`). It does
**not** work on snap-packaged Docker (common on Ubuntu, especially inside LXC),
whose sandboxing breaks the build and hides container health in ways that surface as
confusing, unrelated-looking failures. On Ubuntu/LXC, install the official Docker CE
packages instead (and enable LXC nesting first if you're in an unprivileged
container). With native Docker, no extra flags are needed.
:::

## Reaching it from other machines (`--host`)

By default the server binds to `127.0.0.1` — reachable only from the machine it runs
on, where it runs with a localhost no-auth bypass. To reach it from elsewhere, pick a
bind address:

- `--host <address>` binds a specific reachable address, such as a Tailscale IP. An
  interactive `up` even offers a detected Tailscale address; it never binds beyond
  localhost without your say-so.
- `--host 0.0.0.0` binds **all** interfaces. This is ask-first — a plain `up` prompts
  before exposing everything (`--yes` auto-accepts). `0.0.0.0` is a bind directive,
  not an address to connect to; point clients at the machine's real LAN or tailnet
  IP.

Binding beyond localhost publishes **two** ports on that host: the **agent** surface
on `:3838` (`/mcp`, `/healthz`, `/primer.md`), gated by the agent token, **and the
admin dashboard on `:3000`**. The decrypted-secrets admin *API* itself stays off the
network — it runs on a separate internal listener and a request to the published port
just 404s — but the dashboard that drives it is exposed too, and **dashboard login is
off by default**. Reaching the dashboard is reaching admin power, so protect it: keep
the host on a private/tailnet network **and** turn on owner login — see
[Authentication & secrets](/deploy-and-operate/auth-and-secrets/). **Put both published
ports behind TLS** (a reverse proxy) on any host reachable beyond loopback.

## Where your data lives (`--data-dir`)

By default the vault lives in a Docker-managed named volume. To keep it at a host
path **you** control — to back it up with your own tooling, put it on a particular
disk, or move it between hosts — pass an absolute directory:

```sh
librarian server up --data-dir /srv/librarian
```

This bind-mounts that directory at the container's `/data` and runs the container as
the directory's owner, so the vault stays owned by — and writable by — you. The
directory is created if absent. `--data-dir` and `--data-volume` are mutually
exclusive, and later `update` / `down` / `status` reuse your choice automatically.
Whichever you pick, the data is sacred: recreating the container never touches it.

To move an existing named-volume deploy onto a host directory, copy the volume's
contents across first, then re-`up` with `--data-dir`.

## Keeping it running and up to date

- **`server update`** re-pins forward: fetch the latest release, rebuild, recreate
  the container (your data volume is preserved), apply any pending data migrations,
  and wait for health. It is idempotent — already current and healthy is a clean
  no-op — and it reuses the existing agent token, so clients keep working untouched.
- **`server down`** stops the container with `docker stop` only. It never removes the
  container or the volume; a later `up`/`update` recalls the same memories.
- **`server status`** reports whether it's running, its health, the deployed and
  latest versions, and an up-to-date / update-available badge (degrading gracefully
  to "unknown" when offline rather than crashing).
- **`server logs [-f] [--service mcp|dashboard|all]`** tails the container logs;
  `-f` follows live and `--service` filters the stream.
- **`--ref <tag|main>`** pins `up`/`update` to a specific release or to `main`
  (default: the latest release).

### Start on boot (Linux)

`librarian server enable-boot` (or `server up --enable-boot`) installs a systemd unit
so the container starts on boot. The unit references the existing container and
carries **no secret** — your agent token is never written into the world-readable
unit file. `server disable-boot` reverses it. (macOS boot persistence is deferred;
those commands print a "Linux-only for now" notice and skip cleanly — start the
server manually with `server up`.)

## Admin from the host (`server admin`)

`librarian server admin <command>` runs the bundled admin tool **inside** the
container, so it works even when the dashboard is locked — which is exactly what
makes recovery reliable:

- **`backup`** — push the vault to your configured GitHub backup remote.
- **`restore`** — clone the backup remote back into the data dir. It needs the master
  key (supplied with `--secret-key`, or prompted for with the echo muted), since the
  key is excluded from backups by design. Use `--force` to replace a populated vault.
- **`auth status | reset-password | disable`** — recover dashboard login from the
  host shell (clear a lockout, set a new password, or break-glass disable
  enforcement) without the UI.
- **`rebuild`** — regenerate the in-memory recall index from the vault.

## Checking health from the command line

```sh
pnpm run healthcheck -- --remote http://<host>:3838 --agent-token "$LIBRARIAN_AGENT_TOKEN"
```

In `--remote` mode this probes `/healthz` reachability and `/mcp` authentication
against a running server — handy after an update or for monitoring.

## What `server` does not drive

`librarian server` manages the all-in-one container only. The two-container Docker
Compose stack stays the manual/advanced path — use it when you want the split
mcp-server and dashboard processes, or Compose-native operations. See
[Manual deployment](/deploy-and-operate/manual-install/).
