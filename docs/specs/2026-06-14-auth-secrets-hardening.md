# Spec: auth & secrets hardening (ADR 0008)

**Status:** Ready to build, 2026-06-14. Implements [ADR 0008](../adr/0008-auth-secrets-model.md)
(amends [ADR 0002](../adr/0002-trpc-admin-api.md)). Written with the `sdlc-spec`
method, grounded against the code on `main` @ v1.0.0-rc.7.

## 1. Objective

Make the auth/secrets model match its actual security value instead of *looking*
layered. Three changes from ADR 0008: (1) take the admin tRPC API off the network
and drop the admin token as a network gate; (2) externalize the master key so it
lives off the data volume; (3) make per-client agent tokens + rotation the real
hardening. Audience: self-hosters running a network-exposed (e.g. tailnet) server.

Grounded facts this builds on: the mcp-server runs **one** HTTP listener routing
`/mcp` + `/healthz` + `/primer.md` + `/trpc/*` by path (`routes.ts`); the dashboard
reaches tRPC at `LIBRARIAN_SERVER_URL + /trpc` (`trpc-server.ts`, the proxy route);
`server up` passes secrets **inline** via `-e LIBRARIAN_AGENT_TOKEN=…` (`up.ts:205`);
the per-client token map `LIBRARIAN_AGENT_TOKENS` is already supported
(`auth.ts:13`, `agent-tokens.ts`).

## 2. Success criteria

The acceptance bar; each becomes a test. "Published port" = the host-exposed
`-p <host>:3838`.

1. **Admin API off the network.** `/trpc/*` is **not** served on the published
   listener (a request to `http://<host>:3838/trpc/...` is refused/404), and **is**
   served on a separate internal listener (loopback in the all-in-one; the docker
   network in compose). `/mcp`, `/healthz`, `/primer.md` remain on the published
   listener.
2. **No admin operation is reachable from the published port.** A peer with *any*
   token hitting `http://<host>:3838` cannot invoke an `adminProcedure` or an
   admin-role action — there is no admin surface there to reach.
3. **Admin token dropped for the default deploy.** `server up` no longer mints or
   surfaces an admin token; compose starts **without** `LIBRARIAN_ADMIN_TOKEN`
   (the `:?` requirement is gone); the dashboard still performs all admin
   operations via the internal tRPC endpoint.
4. **Master key off the data volume.** `server up` delivers secrets via a **`0600`
   env-file** (`--env-file`), not inline `-e`; the master key is CLI-minted into
   it; `docker inspect` env does **not** contain the key value; `/data/secret.key`
   is **not** created when the key is env-supplied; the key is surfaced once with
   the SAVE warning.
5. **Externalization documented + boot wired.** README documents the ladder
   (deploy env-file default → `systemd-creds` → external secrets manager); the
   generated `the-librarian.service` references the env-file; reboot still brings
   the server up.
6. **(Phase 2) Per-client tokens + rotation.** Each client is issued a **distinct**
   agent token (populating `LIBRARIAN_AGENT_TOKENS`); a rotate command invalidates
   one client's token (its next call → 401) **without** affecting other clients;
   revoke removes a client.
7. **Releasable.** No secret in any committed file/log/error; `pnpm test` /
   `typecheck` / `lint` green; PR bumps root version + dated CHANGELOG (`check:release`).

## 3. Scope

**Phase 1 (in):** the listener split, dashboard repoint, admin-token removal, master-key
externalization (env-file), and the README/boot wiring. The high-leverage, smaller change.

**Phase 2 (in):** per-client agent tokens + a rotate/revoke command.

**Out of scope:** a **remote dashboard** topology (dashboard on a different host than
the mcp-server) — becomes an explicit, separately-TLS'd opt-in, not built here;
encrypting the vault/memories at rest; a dashboard UI for token management (CLI only
for now); migrating existing single-token deployments' clients automatically.

## 4. Key decisions (from ADR 0008 + grounded)

- **Two listeners, not path-filtering one.** Public listener (`LIBRARIAN_HOST:PORT`,
  published) serves the agent surface; a second listener bound to an internal host
  (`LIBRARIAN_TRPC_HOST`, default `127.0.0.1`) serves `/trpc`. Cleaner + harder to
  misconfigure than source-filtering a shared socket.
- **Internal tRPC is trusted (no admin token).** The internal listener grants admin
  role without a bearer (it's loopback/docker-network only). Public `/mcp` never
  grants admin (agent-role only; there are no `adminOnly` MCP tools today).
- **Secrets via a `0600` env-file + `--env-file`** (move the agent token there too,
  for consistency + to keep it off argv/`docker inspect`). The master key is
  CLI-minted into that file (symmetric with the agent token); the server already
  resolves `env → file → generate`, so it never writes `/data/secret.key`.
- **Per-client tokens reuse the existing `LIBRARIAN_AGENT_TOKENS` map** — no new
  auth primitive, just population + lifecycle.

## 5. Resolved (were open questions, 2026-06-14)

1. **Compose docker-network trust → drop the admin token; isolate the network.**
   All-in-one: tRPC on loopback (`127.0.0.1`), no token (loopback trust). Compose:
   put `mcp-server` + `dashboard` on a dedicated **internal** docker network
   (`internal: true`, not shared with other stacks) with the tRPC port unpublished —
   no token; the boundary is network isolation, not a bearer. Consistent with ADR
   0008's "defense by not-exposing." *(Confirmed 2026-06-14; revisit only if you
   intentionally run other containers on that network.)*
2. **Dashboard tRPC URL → add a distinct `LIBRARIAN_TRPC_URL`** (the agent `/mcp`
   URL and the admin `/trpc` URL are now different ports, so conflating them in
   `LIBRARIAN_SERVER_URL` would be wrong). Defaults to the internal listener:
   `127.0.0.1:<trpc-port>` (all-in-one) / `mcp-server:<trpc-port>` (compose).
3. **Phase 2 client identity → deferred to the Phase-2 spec** (owner decision,
   2026-06-14). The identity scheme (agent-id source) and the management surface
   (where issue/rotate/revoke lives — server vs client) are decided when Phase 2 is
   specced. Phase 2 reuses the existing `LIBRARIAN_AGENT_TOKENS` map (§4); the
   lifecycle UX is intentionally left open here. Phase-1 does not depend on it.

## 6. Task plan

Vertically sliced, ordered by dependency, riskiest first. Each leaves the system working.

### Phase 1 — shrink the surface + externalize the key

- [ ] **P1 — split the mcp-server HTTP into two listeners.** Public
      (`/mcp`,`/healthz`,`/primer.md`) on `LIBRARIAN_HOST:PORT`; internal (`/trpc/*`)
      on `LIBRARIAN_TRPC_HOST` (default `127.0.0.1`) : `LIBRARIAN_TRPC_PORT`.
      *Accept:* `/trpc` on the public listener → 404/refused; `/trpc` on the internal
      listener → works; `/mcp` only on public. (SC 1.) *Depends:* none. *(riskiest — first)*
- [ ] **P2 — repoint the dashboard at the internal tRPC endpoint** (server-side
      client + browser proxy), and wire it in the all-in-one (supervisor env →
      `127.0.0.1:<trpc-port>`) and compose (`mcp-server:<trpc-port>`, not published).
      *Accept:* dashboard tRPC calls succeed via the internal endpoint; the published
      port serves no `/trpc`. *Depends:* P1.
- [ ] **P3 — drop the admin token as a network gate.** Internal listener grants
      admin role without a bearer; remove admin-token auto-generation, the compose
      `:?` requirement, and `server up`'s surfacing of it.
      *Accept:* `server up` prints no admin token; compose starts without
      `LIBRARIAN_ADMIN_TOKEN`; no `adminProcedure` reachable from the published port.
      (SC 2, 3.) *Depends:* P1, P2. *(see Open Q1)*
- [ ] **P4 — deliver secrets via a `0600` env-file; mint the master key into it.**
      Switch `server up` from inline `-e` to `--env-file`; CLI mints
      `LIBRARIAN_SECRET_KEY` (like the agent token); server uses env, never writes
      `/data/secret.key`.
      *Accept:* `docker run` uses `--env-file`; file mode `0600`; key absent from
      `docker inspect` env + from `/data`; surfaced once. (SC 4.) *Depends:* P3
      (same `up.ts` region — serialize).
- [ ] **P5 — externalization docs + boot wiring.** README ladder (env-file →
      `systemd-creds` → external manager); `the-librarian.service` references the
      env-file.
      *Accept:* README documents the ladder; generated unit references the env-file;
      reboot brings the server up. (SC 5.) *Depends:* P4.
- [ ] **P6 — Phase 1 release gate.** tests/typecheck/lint green; version bump +
      CHANGELOG; PR. (SC 7.) *Depends:* P1–P5.

### Phase 2 — per-client agent tokens + rotation

> **SUPERSEDED (2026-06-15).** This Phase 2 (P7–P9) was written against rc.7 and is
> stale — a DB-backed token store + dashboard Tokens page shipped since, and the
> identity model changed (identity now comes from a transport-injected
> `harness@machine` header, not the token). Build from
> [2026-06-15-agent-tokens-and-identity.md](./2026-06-15-agent-tokens-and-identity.md)
> instead; the tasks below are kept only as history.

- [ ] **P7 — issue per-client agent tokens.** Mint a distinct token per client,
      populating `LIBRARIAN_AGENT_TOKENS`. *Identity scheme + management surface are
      deferred to the Phase-2 spec (§5.3)* — design them there before building.
      *Accept:* each client gets a distinct token; the map is populated; a token
      authenticates only as its own agent. (SC 6, part.) *Depends:* P4 (env-file
      delivery for the map). *(Phase-2 spec decides the details first.)*
- [ ] **P8 — rotate / revoke a client's token.** A command regenerates or removes
      one client's token and reloads the server.
      *Accept:* rotating invalidates that client's old token (401) without affecting
      others; revoke removes a client. (SC 6, part.) *Depends:* P7.
- [ ] **P9 — Phase 2 release gate.** Gate + PR. *Depends:* P7, P8.

## 7. Checkpoint

Phase 1 is the security win and is independently shippable; Phase 2 (per-client
tokens) is the larger investment and can follow. The §5 questions are resolved
(Q1/Q2 confirmed; Q3 deferred to the Phase-2 spec), so Phase 1 (P1–P6) is ready to
hand to `sdlc-implement`. Phase 2 (P7–P9) needs its own spec first (the deferred
identity/lifecycle design).
