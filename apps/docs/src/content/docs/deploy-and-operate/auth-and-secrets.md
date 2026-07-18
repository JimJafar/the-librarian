---
title: Authentication & secrets
description: How The Librarian's access model works, how to turn on dashboard login, and how the master key protects your secrets.
---

The Librarian's steady-state security model is deliberately small: there are only
**two** credentials that do ongoing work, and one of the admin surfaces simply does
not exist on the network at all. An optional, one-shot bootstrap secret can provision
the first owner; after redemption its capability becomes inert behind a durable burn
flag and the enabled-owner gate. This page explains the model, how to turn on dashboard
login, and what the master key does (and does not) protect.

## The access model

- **The agent token is the network boundary.** It is the only credential that
  authenticates `/mcp` (memory read and write) across the network, and the only thing
  the published port enforces. Prefer per-agent tokens minted in the dashboard's
  [Tokens](/dashboard/settings/#tokens) page; the environment variables
  `LIBRARIAN_AGENT_TOKEN` / `LIBRARIAN_AGENT_TOKENS` are the no-dashboard fallback.
- **There is no admin token.** The admin API — which can return *decrypted* secrets
  and do full memory edits — is off the network entirely. It runs on a separate
  internal listener (loopback inside the all-in-one container; an unpublished internal
  network in Compose), reachable only by the co-located dashboard, and it grants admin
  access **by isolation**, with no bearer token. An admin request to the published
  port simply returns 404. This is "security by not exposing" — strictly safer than
  guarding a network surface that need not exist.
- **The master key protects the server's own credentials only** — see
  [the master key](#the-master-key) below.
- **The optional bootstrap-claim secret exists only for first-owner provisioning.**
  When armed, it closes the unauthenticated setup window until one short-lived,
  signed claim creates the owner and enables login. The durable burn flag and the
  enabled-owner state each prevent reuse. Leave it unset for the ordinary dashboard
  wizard; see [Scripted first-owner bootstrap](/deploy-and-operate/self-host/#scripted-first-owner-bootstrap)
  for the ceremony and recovery steps.

Because the dashboard is the only client of that internal admin listener, **reaching
the dashboard is reaching admin power**. Keep the published host on a private network,
and turn on owner login below for anything internet-exposed.

## Dashboard login (single owner)

The dashboard can require the owner to sign in rather than relying only on a private
network. It is **off by default** and **recommended for any internet-exposed
deployment**. When on, every dashboard page redirects an unrecognised visitor to a
login screen.

### The recommended way: configure it in the dashboard

Open **[Settings → Auth](/dashboard/settings/#auth)** and follow the wizard:

1. **Set a method** — a username and password (no third-party account required),
   and/or wire GitHub or Google login (the wizard shows the exact callback URL to
   register and takes the client id/secret plus your owner account id).
2. **Enable enforcement.** Turning it on asks for a one-time confirmation value — a
   land-grab guard, so a stranger who reaches a not-yet-enforced dashboard on a shared
   network cannot enable it and lock you out. Set `LIBRARIAN_ADMIN_TOKEN` to a value
   of your choosing in the server's environment and paste it here, or enable from the
   host shell instead (below). Enforcement flips on immediately — no redeploy.

Config lives in the store and the session key is derived from the master key, so
there is nothing extra to set. Too many wrong passwords triggers a lockout.

### Recovering from a lockout

From the host shell (these work even when the dashboard is locked):

```sh
the-librarian auth status            # what's configured (no secrets shown)
the-librarian auth reset-password    # set a new password, clears the lockout
the-librarian auth disable           # break-glass: turn enforcement off
```

With the one-command CLI, the same is reachable as `librarian server admin auth …`.

### Legacy: env-configured auth

Older deployments can still configure auth entirely through environment variables
(`LIBRARIAN_AUTH_ENABLED`, `AUTH_SECRET`, `AUTH_URL`, the OAuth client vars, and an
owner allowlist). Store config wins when present; new installs should prefer the
wizard. One safety note carries over: **allowlist GitHub owners by numeric account
id, not email** — a GitHub OAuth profile email is attacker-settable, so the email
fallback is ignored for GitHub (Google, which asserts verification, is honoured).

## The master key

The master key (`LIBRARIAN_SECRET_KEY`) is an AES-256 key that protects **only** the
server's own third-party credentials — the curator's LLM API key, the backup GitHub
token, any OAuth client secrets — and derives the dashboard's session-signing key.

It does **not** encrypt your vault or your memories. Those are plain Markdown in a Git
repo **by design**, so they stay editable in any editor. "Master key" does not mean
"the data is encrypted at rest" — it isn't, deliberately.

### What keeping the key off the volume buys you

Moving the key off the data volume defends the **at-rest** case: if a volume snapshot
or backup tarball leaks, the key is not in it, so the encrypted credentials stay
encrypted. (Vault backups never contained the key anyway.) It does **not** defend a
live-host compromise — anyone with root on the running machine can read the key from
process memory no matter where it is configured. We state this plainly rather than
imply more.

### The externalization ladder

Pick the lowest rung that meets your threat model:

- **(a) Default — a `0600` deploy env-file.** `librarian server up` mints the key and
  writes it, with the agent token, into a `0600` env-file kept off the data volume,
  then runs the container from it. This is the zero-friction default and closes the
  realistic at-rest threat (a leaked volume or backup).
- **(b) `systemd-creds` (TPM-bound, Linux).** For also defending **offline host-disk
  theft**, encrypt the key bound to the host's TPM so an offline disk image cannot
  decrypt it. Under the shipped boot model this is an advanced, operator-driven setup
  (you own how the decrypted key reaches the container); a turn-key path is a
  documented follow-up.
- **(c) External secrets manager.** On the first deploy, capture the surfaced key and
  store it in your manager (Vault, AWS/GCP Secrets Manager, 1Password) as the
  canonical copy, where rotation and audit live. Both `up` and `update` then **reuse**
  that key on every run — they never silently rotate it, because re-keying would
  orphan every secret encrypted under the old key. Treat the first-deploy key as
  durable.

There is no turn-key rotation: once set, the key is preserved. If you must re-key
deliberately, stand up a fresh deployment with a new key and re-enter the encrypted
settings (curator token, backup token) in the dashboard.
