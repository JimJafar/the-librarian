# Spec: agent tokens & transport-injected identity (auth/secrets Phase 2)

**Status:** Ready to build, 2026-06-15. **Re-grounds and supersedes** the deferred
Phase 2 (P7–P9) of [2026-06-14-auth-secrets-hardening](./2026-06-14-auth-secrets-hardening.md),
which was written against rc.7 and is now stale (a DB-backed token system + dashboard
Tokens page shipped since). Builds on [ADR 0008](../adr/0008-auth-secrets-model.md)
(Phase 1 shipped: listener split, admin token dropped, master key externalized).
Written with the `sdlc-spec` method, grounded against `main` @ v1.0.0-rc.15.

## 1. Objective

Make agent **identity** reliable and zero-effort, and make agent **tokens** a clean,
manageable secret with leak visibility — without the security theatre the original
Phase 2 implied. Two things, deliberately **decoupled**:

- **Identity** (who wrote a memory) comes from the **transport** — each harness's
  integration injects `harness@machine` at install time — not from the model
  self-reporting an `agent_id`, and not from the token. Reliable, no extra tool
  calls, and one less field for the model to produce on every write.
- **Tokens** (the network credential) are **pure secrets** at whatever granularity
  the operator chooses (one shared, per-harness, or per-machine — their call),
  managed from the dashboard **and** a host CLI, with rotate/revoke and per-token
  last-seen + source-IP observability so a leaked token is **visible and killable**.

Audience: self-hosters, especially tailnet-exposed servers.

### Grounded facts this builds on (verified against `main`)

- DB token store exists — `packages/core/src/auth/agent-tokens.ts`: `createAgentToken`
  / `listAgentTokens` / `revokeAgentToken` / `verifyAgentToken`. Shape `lib.<id>.<secret>`,
  salted SHA-256 hash, plaintext returned once, stored in `settings` (`agent_token:<id>`),
  works without `LIBRARIAN_SECRET_KEY`.
- Admin token tRPC exists — `packages/mcp-server/src/trpc/tokens.ts` (`list`/`create`/`revoke`,
  `adminProcedure`), reachable only on the internal listener (ADR 0008 Phase 1).
- Dashboard Tokens page exists — `apps/dashboard/app/tokens/`, `components/tokens/`.
- `resolveCaller` already defines `injectedAgentId` as the **highest-trust** id source
  (`packages/core/src/caller-identity.ts`), with normalisation + reserved-namespace
  guards — but **nothing wires it to a header** yet. It also currently *rejects* a
  request whose supplied id ≠ a token-bound id (the impersonation check).
- MCP tools still take **and require** `agent_id` — `mcp/tools/schemas.ts`
  (`required: ["agent_id", …]`), scoped in `mcp/visibility.ts` (`scopeAgentArgs`).
- Integrations already send a `headers` block — `integrations/claude/.mcp.json`
  (`Authorization: Bearer …`); opencode/codex take config headers; pi/hermes are our
  own HTTP clients (`integrations/pi/extensions/librarian/mcp-client.ts`).
- `librarian install` knows the harness it configures and already captures the machine
  hostname (`packages/installer-cli/src/machine.ts`).

## 2. Success criteria (each becomes a test)

1. **Transport identity.** A request carrying `X-Librarian-Agent: <harness>@<machine>`
   attributes its writes to that actor, normalised + reserved-namespace-guarded by
   `resolveCaller` (a header claiming `system-*` / `dashboard-*` / `cli` is **refused**,
   not honoured).
2. **No `agent_id` on the agent surface.** None of the 7 MCP verbs (`recall`,
   `remember`, `flag_memory`, `store_handoff`, `list_handoffs`, `claim_handoff`,
   `search_references`) accept or require `agent_id`; the tool-registry test, the
   primer, the slash-command docs, and the **Hermes/Pi adapter mirrors + drift guards**
   are all updated in the same PR and stay green.
3. **Header set automatically at install.** A fresh `librarian install` for harness H
   on machine M writes `X-Librarian-Agent: H@M` into that harness's generated MCP
   config, with no user input. All five integrations carry it.
4. **Safe fallback.** With no header (e.g. a raw `curl` client), a write resolves to
   `unknown@<source-ip>` — never an error, never an impersonated reserved id.
5. **Tokens are secrets only.** A token carries no identity; creating one takes a human
   **label** (e.g. "main"), not an agent id. Identity is never derived from the token.
6. **DB-canonical token store.** The `LIBRARIAN_AGENT_TOKENS` **map** is hard-removed (no
   deprecation window); a boot with it still set logs a loud, **edge-safe** warning and
   the map is inert. The single **`LIBRARIAN_AGENT_TOKEN`** remains a valid client
   credential (the documented break-glass bootstrap). `server up` seeds the **first** DB
   token and surfaces it once.
7. **Rotate.** Rotating a token keeps its id + label and swaps the secret; the old
   secret → 401 immediately, other tokens unaffected; the new plaintext is shown once.
8. **Revoke** (exists). Revoking → that token's next call 401s immediately, no restart,
   others unaffected.
9. **Host CLI parity.** `librarian server token {create,list,rotate,revoke}` performs
   the same operations from the host shell (reaching the internal admin surface), for
   headless / no-dashboard servers.
10. **Leak observability.** Each token records last-seen + the set of distinct source
    IPs (from the connection, **not** `X-Forwarded-For` unless behind a configured
    trusted proxy); the dashboard Tokens page and `token list` display them. **No
    geolocation in v1.**
11. **Releasable.** No secret in any committed file/log/error; `pnpm test` / `typecheck`
    / `lint` green; PR bumps root version + dated CHANGELOG (`check:release`).

## 3. Scope

**In:** transport-injected identity; dropping `agent_id` from the agent surface;
label-only DB tokens; rotate; the host CLI; per-token last-seen/IP observability;
install writing the header; migration off the env map.

**Out:** geolocation / whois enrichment (later — and moot on a tailnet's CGNAT IPs); a
smoother client-pairing/distribution flow (copy-paste stays); multi-tenant / cross-owner
trust (the Librarian is single-owner); **any use of the identity header for an access
decision** (it is a label, never a gate); remote (off-box) token administration.

## 4. Key decisions (resolved in the 2026-06-15 design discussion)

- **Identity = transport, not token, not model.** Read `X-Librarian-Agent:
  harness@machine` at the MCP boundary → `resolveCaller({ injectedAgentId })` (highest
  trust). The model never sends an id. *Why:* agents self-report inconsistently; the id
  was never a secret, so binding it to a token is theatre; the transport value is
  reliable, zero-effort, and one field lighter per call.
- **Spoofable-but-fine.** The header is client-set and therefore spoofable, but identity
  is a **label, never access control** — the token stays the only security boundary, and
  the harder-to-spoof leak signal is the **source IP**. The reserved-namespace guard
  still stops a header from claiming a system/admin actor.
- **Tokens are secrets at operator-chosen granularity.** One shared token across
  everything is first-class; per-harness or per-machine is the operator's choice, purely
  for revocation convenience. `create` takes a human **label**, not an agentId; the
  token's stored `agentId` field is dropped.
- **No identity verification.** Drop `resolveCaller`'s reject-on-mismatch **for the
  agent surface** — it breaks the "one token everywhere" pattern and trips on
  inconsistent agents for zero security gain. (`resolveCaller` stays general for the
  CLI / dashboard / system callers that still pass their own ids.)
- **DB store canonical; env map hard-removed (§5).** Remove `LIBRARIAN_AGENT_TOKENS` (the
  map) outright — no deprecation window; if it's still set, boot logs a loud edge-safe
  warning and ignores it. The single `LIBRARIAN_AGENT_TOKEN` **stays a supported client
  credential** — the documented **break-glass** bootstrap that authenticates as the
  fallback identity, so a wonky DB can't lock you out. `server up` seeds the first DB
  token + surfaces once.
- **Host-only administration.** Token ops run on the host: the dashboard (browser to the
  internal surface) or the new CLI (reaching the internal admin tRPC, via `docker exec`
  for container deploys). No network-exposed token admin — consistent with ADR 0008.
- **Observability at the auth boundary, throttled.** Record last-seen + source IP **after**
  a successful verify, in the HTTP layer (not the pure `verifyAgentToken`), throttled
  (≈ ≤ once/min/token) to avoid a write per request. Source IP from the socket; honour
  `X-Forwarded-For` only behind a configured trusted proxy.

## 5. Resolved (were open questions; owner-confirmed 2026-06-15)

1. **Break-glass single token → keep it.** `LIBRARIAN_AGENT_TOKEN` (single) stays a
   supported, documented break-glass client credential, so a wonky/unseeded DB can't lock
   you out.
2. **Env-map removal → hard-remove now.** The `LIBRARIAN_AGENT_TOKENS` **map** is removed
   outright (no deprecation window); a boot with it set logs a loud edge-safe warning and
   ignores it. *Explicitly:* this removes only the **map** — the single
   `LIBRARIAN_AGENT_TOKEN` (§5.1) still authenticates clients.
3. **Header name → `X-Librarian-Agent`.** Confirmed.
4. **No-header fallback → `unknown@<source-ip>`.** More forensic (the IP lands in the
   actor id); normalise/bound it per the caller-identity contract (IPv6 colons included).

## 6. Task plan

Vertical slices, ordered by dependency, each leaves the system working. P1–P3 deliver
the headline (reliable zero-effort identity, `agent_id` gone) and are independently
shippable; P4–P8 are the token lifecycle + observability.

- [ ] **P1 — Wire transport identity (read-side).** Read `X-Librarian-Agent` at the MCP
      boundary → `injectedAgentId` → `resolveCaller`; keep the reserved-namespace guard;
      drop the agent-surface reject-on-mismatch; resolve to `unknown@<source-ip>` when the
      header is absent.
      *Accept:* a header attributes the write; a reserved-id header is refused; no header
      → `unknown@<source-ip>` (no error). *Depends:* none. *(riskiest — first)*
- [ ] **P2 — Drop `agent_id` from the agent surface.** Remove it from the 7 MCP tool
      schemas + `scopeAgentArgs`; update the tool-registry test, the primer
      (`packages/core/src/primer.ts` / `vault/primer.md`), `docs/slash-commands.md`, and
      the **Hermes/Pi adapter mirrors + drift guards** — all in this PR.
      *Accept:* tools reject/ignore `agent_id`; every drift/contract test green.
      *Depends:* P1.
- [ ] **P3 — Install writes the header.** `librarian install` bakes
      `X-Librarian-Agent: <harness>@<hostname>` into each harness's MCP config; all five
      integration templates carry it.
      *Accept:* a fresh install yields the header; integration-config tests assert it.
      *Depends:* P1.
- [ ] **P4 — Tokens become label-only secrets.** Drop the token `agentId` field; `create`
      takes `label`; update core, `tokensRouter.create`, and the dashboard generate-form.
      *Accept:* a token has a label and no identity; existing token flows pass.
      *Depends:* P1 (identity no longer comes from the token).
- [ ] **P5 — Rotate.** Add `rotateAgentToken(id)` to core + `tokensRouter`: same id +
      label, new secret/salt/hash, old secret → 401, new plaintext shown once.
      *Accept:* rotate invalidates the old secret, leaves others, surfaces the new once.
      *Depends:* P4.
- [ ] **P6 — Host CLI.** `librarian server token {create,list,rotate,revoke}` reaching
      the internal admin tRPC (via `docker exec` for container deploys).
      *Accept:* each subcommand performs the op from the host shell; nothing is network-
      exposed. *Depends:* P4, P5.
- [ ] **P7 — Leak observability.** Record last-seen + distinct source IPs per token at the
      auth boundary (throttled; socket IP; XFF only behind a configured trusted proxy);
      surface in the dashboard Tokens page + `token list`.
      *Accept:* a request updates last-seen + records its IP; both surfaces display them.
      *Depends:* P4.
- [ ] **P8 — Remove the env map + bootstrap.** Hard-remove `LIBRARIAN_AGENT_TOKENS` (no
      deprecation window; a loud edge-safe warning if it's still set, then ignored);
      **keep the single `LIBRARIAN_AGENT_TOKEN`** as the break-glass client credential
      (§5.1); `server up` seeds the first DB token + surfaces once; migration doc in
      `DEPLOYMENT.md`.
      *Accept:* the map is no longer honoured (warns if set); the single token still
      authenticates; a fresh `server up` yields a working first token; docs cover the
      migration. *Depends:* P4.
- [ ] **P9 — Phase 2 release gate.** tests/typecheck/lint green; version bump + CHANGELOG;
      PR. *Depends:* P1–P8.

## 7. Checkpoint

The §5 questions are resolved (owner-confirmed 2026-06-15), so the plan is ready to
build. P1–P3 (identity) are the high-leverage, independently-shippable win; P4–P8 (token
lifecycle + observability) follow. Hand each slice to `sdlc-implement` (or the whole plan
to `sdlc-orchestrate`).
