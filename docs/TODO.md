# TODO / deferred follow-ups

Tracked backlog of deferred work surfaced during the autonomous builds. None are
blocking; each is a focused follow-up PR. Grouped by theme, roughly highest-value
first within each group. Remove an item when its PR merges.

## Security & hardening

- **`/healthz` info disclosure.** `GET /healthz` returns auth-posture booleans
  (`mcp_auth`, etc.) unauthenticated. Keep `{status:"ok"}` public; move the
  auth-posture fields behind admin auth. Touches the `/healthz` contract,
  `packages/mcp-server/tests/http/routes.test.ts`, and the healthcheck script.
  _(deploy review)_
- **Rate-limit the `/mcp` auth surface.** No throttling on bearer-token
  verification → online guessing isn't slowed. Add per-IP/token rate limiting in
  a focused hardening PR. _(A3 review)_

## Correctness & robustness

- **Restore cross-file atomicity.** `restoreBackup` is atomic per file (temp +
  rename) with an up-front checksum pass, and is idempotent on re-run, but a crash
  *between* files leaves a mixed data dir. Not done: full stage-into-temp-dir-then-
  swap + reconciling/removing data-dir files absent from the manifest (e.g. a
  lingering pre-R3 `sessions.jsonl`). _(B1 review)_
- **Enforce store-closed on CLI `restore`.** `restoreBackup` has no store handle,
  so it can't detect an open store. The CLI `restore` command MUST refuse (or
  close) when the store is open, to avoid restoring under a live connection.
  _(B1 review)_

## Testing

- **Auth-enabled Playwright e2e.** The shared e2e webServer runs with auth off, so
  the unauth→`/login` redirect and authed-session page flows are only unit-tested
  (`tests/auth-gate`, `tests/trpc-proxy-gate`) plus a `/login` render smoke. A full
  browser auth path needs a dedicated Playwright project + an auth-enabled server
  (with `AUTH_SECRET` + a test owner). _(A2 review)_

## Deploy & ops

- **Verify `fly.toml` against the current Fly schema.** It's a starter template;
  the schema (`auto_stop_machines` value type, `[mounts]` form,
  `[[services]]`/`[http_service]`) was not live-verified — see the header note in
  `fly.toml` and DEPLOYMENT.md. The host-agnostic `docker run` one-liner is the
  primary path.
- **Revisit `LIBRARIAN_AUTH_ENABLED` default in the all-in-one image.** Kept OFF
  by default (a fresh `docker run` would otherwise lock out without `AUTH_SECRET` +
  an owner). The spec suggested on-by-default for the recommended config. If you
  want opt-out instead, set `ENV LIBRARIAN_AUTH_ENABLED=true` in
  `docker/all-in-one.Dockerfile` — but then first-run requires full auth config.
  _(A2 decision)_

## Dependencies

- **Bump `next` / `postcss`.** A moderate advisory (GHSA-qx2v-qp2m-jg93) sits in
  the lockfile via `next` (build-time CSS tooling, not a runtime input path — not a
  regression). Worth a repo-wide bump in its own change. _(A1)_

## Auth enhancements (optional)

- **GitHub verified-email allowlisting.** The email allowlist
  (`LIBRARIAN_OWNER_EMAILS`) is honored only for provider-verified emails; GitHub
  carries no `email_verified`, so it's effectively Google-only and GitHub owners
  must use `LIBRARIAN_OWNER_GITHUB_ID`. If GitHub email allowlisting is wanted,
  fetch verified emails from `GET /user/emails` (extra scope + API call). Skipped
  for single-owner where the account id is the robust key. _(A1)_
- **Full browser-based MCP OAuth** remains explicitly out of scope (see
  `docs/specs/single-owner-auth.md`) — revisit via a managed provider only when
  there are non-technical users or many clients.

## Cross-repo: `the-librarian-claude-plugin`

The sibling plugin repo (`/Users/jim/code/the-librarian-claude-plugin`, GitHub
`JimJafar/the-librarian-claude-plugin`) bundles `@librarian/lifecycle` as a
committed esbuild artifact — a coupling invisible from this repo.

- **Regenerate the plugin bundle after any `@librarian/lifecycle` change.**
  `npm run build` in the plugin repo (needs a sibling `the-librarian` checkout or
  `LIBRARIAN_MONOREPO`), then commit — its CI has a `PROVENANCE.json` hash
  drift-guard that fails on a stale bundle.
- **Flip the plugin repo to PUBLIC** before distributing via the marketplace
  (currently private).
- **Codex plugin.** The codex adapter has remote-transport support but no
  distributable plugin yet (test-only) — a codex plugin could follow the Claude
  plugin's shape.
