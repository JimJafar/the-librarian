# Deploying The Librarian

The full operator guide now lives in the in-repo documentation site under
**Deploy & operate** (`apps/docs`). It is the canonical home for deployment and
operations prose, so it is not duplicated here. This page is a short signpost.

The Librarian runs as one small self-hosted server, designed for a low-traffic
personal VPS or remote host. The lowest-friction path is the one-command CLI:

```sh
npx @the-librarian/cli server up
```

> **Use native Docker, not the snap package.** `librarian server` is unsupported
> on snap-packaged Docker (common on Ubuntu / LXC) — install Docker CE. The
> reasons are in the self-host guide below.

## Where the detail lives

The deployment and operations guide is split into three pages in the docs site:

- **[Self-host](apps/docs/src/content/docs/deploy-and-operate/self-host.md)** —
  the one-command `librarian server` path end to end: `up` / `update` / `down` /
  `status` / `logs`, the native-Docker requirement, network bind (`--host`), data
  location (`--data-dir`), boot persistence (`enable-boot`), host-side admin
  (`server admin backup|restore|auth|rebuild`), and the command-line healthcheck.
- **[Manual deployment](apps/docs/src/content/docs/deploy-and-operate/manual-install.md)**
  — running Docker yourself: the single all-in-one container, the two-container
  Compose stack, Fly.io, the endpoint reference (`/mcp`, `/healthz`, `/primer.md`),
  origin checks, and day-to-day operations (logs / upgrade / stop).
- **[Authentication & secrets](apps/docs/src/content/docs/deploy-and-operate/auth-and-secrets.md)**
  — the auth model (the agent token is the network boundary; there is no admin
  token — ADR 0008), turning on dashboard owner-login and recovering from a
  lockout, and the master-key externalization ladder (what it protects, and what
  it doesn't).

Backups and restore are covered as a task guide at
[`apps/docs/src/content/docs/guides/backups-restore.md`](apps/docs/src/content/docs/guides/backups-restore.md).

The design decisions behind the deployment model live in
[`docs/adr/`](./docs/adr/) — notably
[ADR 0008](./docs/adr/0008-auth-secrets-model.md) (the auth/secrets model).
