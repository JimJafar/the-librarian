# ADR 0008 — Auth & secrets model: shrink the network surface, externalize the key

- **Status:** Accepted
- **Date:** 2026-06-14
- **Amends:** ADR 0002 (tRPC admin API) — the tRPC choice stands; its *network exposure* changes.
- **Related:** ADR 0001 (separate services), ADR 0006 (agent-facing MCP surface).

## Context

Shipping the one-command `librarian server` CLI (v1.0.0-rc.7) made it trivial to
stand up a **network-exposed** server (e.g. bound to a tailnet IP), which prompted
a review of what each credential actually protects. Reading the code (not the
marketing) turned up a model that looks layered but mostly isn't:

- **The data is not encrypted at rest.** The vault — your memories — is plaintext
  markdown in a git repo, deliberately (so it's editable in Obsidian/any editor).
  The master key never touched it.
- **The master key (`LIBRARIAN_SECRET_KEY`) protects only the server's *own*
  third-party creds** in `settings.json` (the curator LLM API key, the backup
  GitHub PAT, OAuth client secrets) and derives the dashboard session-signing key.
  But in the default mode the server **auto-generates it into the data volume**
  (`/data/secret.key`, 0600) — *beside* the ciphertext it protects. Against the
  realistic at-rest threat (a data-volume snapshot/backup/shared-storage leak) the
  key and ciphertext leak together, so the encryption provides ~no protection. It
  is real only if the key lives **off** the data volume.
- **The admin tRPC API is network-exposed only incidentally.** `/trpc/*` and
  `/mcp` are dispatched off the *same* HTTP listener (`routes.ts`), which binds
  `0.0.0.0` and is published because **`/mcp` must be reachable by remote agents**.
  The only legitimate tRPC caller — the dashboard — always reaches it *internally*
  (loopback in the all-in-one; the docker network in compose). No supported
  topology needs remote admin tRPC. Yet a network peer with the admin token can
  `POST /trpc/auth.config` and get back **decrypted** secrets, full memory CRUD,
  backup/auth config — bypassing the dashboard entirely.
- **The admin token therefore guards a surface that shouldn't exist** on the
  network. Its in-practice job is "the credential the co-located dashboard uses."
- **The agent token is the one genuinely load-bearing credential** — it's the only
  thing authenticating memory read/write across the network, and it's *used on
  every client call*. Its real exposure is **client-side**: it sits plaintext in
  `~/.librarian/env` on every client machine (N copies vs one server).

Net: a real core (the agent token) wrapped in two weak/incidental layers (the
co-located master key; the admin token's network gate) that give the *appearance*
of depth without the substance.

## Decision

Three changes, smallest-surface-first:

1. **Internalize the admin tRPC surface; drop the admin token as a network gate.**
   Serve `/trpc/*` on an internal-only listener (loopback in the all-in-one; the
   docker network in compose), separate from the **public** listener that carries
   `/mcp` + `/healthz` + `/primer.md`. The published port (`-p <host>:3838`) then
   exposes only the agent surface. With tRPC unreachable from the network, the
   admin token is no longer a network gate and is dropped for the default
   (co-located-dashboard) deploys. A **remote** dashboard becomes an explicit,
   separately-secured opt-in (its own TLS-terminated exposure), never the default.

2. **Externalize the master key.** The CLI **mints** it at install (exactly as it
   already mints the agent token) and passes it via env, so it lives in the
   **deploy config, not the data volume**. The server already resolves
   `env → file → generate`, so an env-supplied key is never written to `/data`.
   Document a ladder (low→high assurance): (a) **default** — CLI-minted key in a
   `0600` deploy env-file the unit references (off the data volume); (b)
   **`systemd-creds`** (TPM-bound) for the Linux/systemd boot path; (c) an
   **external secrets manager** for those who run one. Stop describing this as
   "encrypted at rest" beyond what externalization actually delivers.

3. **Treat the agent token as the real security boundary.** Invest hardening
   *here*, since client-side leak is the dominant threat: **per-client tokens**
   (the `LIBRARIAN_AGENT_TOKENS` map already supports distinct tokens per agent, so
   one leak is revocable without re-keying everyone) plus a documented
   **rotation/revocation** story.

## Consequences

**Positive**
- The dangerous admin API (notably `auth.config`, which *returns decrypted
  secrets*) is **off the network** — defense by not-exposing, strictly better than
  defense by token. Removes the largest attack surface.
- Externalizing the key makes at-rest encryption **actually meaningful** for the
  realistic data-volume-leak threat, at near-zero user friction (the CLI handles
  it; the user never types it).
- Per-client agent tokens make the high-exposure credential **revocable** without a
  fleet-wide re-key.
- Fewer credentials to reason about: the admin token disappears for the common
  case; the model collapses to "agent token = network auth, master key = at-rest
  for the server's own creds (externalized)."

**Negative / costs**
- A code change to **split the mcp-server's HTTP listener** (public vs internal)
  plus dashboard config to reach the internal tRPC endpoint. Amends the transport
  assumption in ADR 0002 (the tRPC *shape* is unchanged).
- A **remote dashboard** now needs deliberate setup rather than working by
  accident. Acceptable: it was never a supported topology.
- Key-in-deploy-env (default tier) does **not** protect against a full host/root
  compromise — only against data-volume leakage. We state this honestly rather
  than imply more. `systemd-creds`/external managers raise the bar for those who
  want it.
- Per-client tokens + rotation add operational surface (managing/rotating a set
  rather than one shared token).

**Threat model (explicit):** these changes target (a) network attack surface and
(b) data-volume-leak at rest. They do **not** claim protection against a root/host
compromise, which can read process memory regardless.

## Alternatives considered

- **Keep admin tRPC public, rely on the admin token (status quo).** Rejected:
  defense-by-token over a surface that needn't exist; the network exposure is
  incidental, not required.
- **Encrypt the vault/memories at rest.** Rejected: breaks the plaintext-markdown,
  edit-in-Obsidian design; and the realistic threat is the whole volume, which
  per-file encryption-with-a-co-located-key wouldn't address anyway.
- **Store the master key in GitHub at install.** Rejected: GitHub Actions secrets
  are write-only / CI-scoped (a running server can't read them back); a private
  repo/gist is just "key in a repo" plus a PAT chicken-and-egg. No GitHub product
  fits runtime secret retrieval.
- **Back up secrets/settings for "complete DR".** Rejected: on a fresh-server
  restore the agent token, admin token, and master key all regenerate and the
  vault is plaintext, so nothing needs preserving — you reconfigure a couple of
  third-party creds. Backing up secrets only saves re-entry, at the cost of a new
  secret-leak surface on the backup remote.
