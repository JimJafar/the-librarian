# Dashboard REST endpoints lack authentication

**Status:** Resolved (2026-05-20 in T7.1 — the legacy `/api/*` REST surface is deleted; the new dashboard talks to the admin-gated tRPC API only)
**Discovered:** 2026-05-12
**Discovered by:** Joseph (SDLC release/ops agent)

## Summary

The dashboard REST API endpoints have no authentication, while the MCP endpoint (`/mcp`) is properly gated behind a Bearer token. Any process with localhost access can read, write, or delete memories without admin privileges.

## Affected endpoints

| Endpoint | Method | Auth |
|---|---|---|
| `/api/state` | GET | None |
| `/api/events` | GET | None |
| `/api/memories` | POST | None |
| `/api/memories/{id}/update` | POST | None |
| `/api/memories/{id}/delete` | POST | None |
| `/api/recall` | POST | None |
| `/mcp` | POST | Bearer token ✅ |

## Repro

```bash
# Delete a memory — no auth required
curl -s -X POST http://127.0.0.1:3838/api/memories/mem_<id>/delete \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "joseph"}'

# Read all memories and events — no auth required
curl -s http://127.0.0.1:3838/api/state
```

## Root cause

The `authenticateMcp()` middleware runs only for the `/mcp` route (line 92 in `src/dashboard.js`). The REST routes at lines 124-227 skip auth entirely. When the dashboard binds to a non-localhost address (e.g., Tailscale IP via `LIBRARIAN_PUBLISHED_HOST`), the `allowNoAuth` guard on line 27-29 also doesn't trigger because `host !== "127.0.0.1"`.

## Proposed fix

Either:

1. **Gate REST endpoints behind MCP auth** — apply `authenticateMcp()` to the REST routes, or
2. **Accept localhost-only as the security boundary** — refuse to start the dashboard on non-localhost unless REST auth is explicitly configured.

The status quo (MCP is gated but REST is open) is inconsistent and surprising.

## Impact

An agent or process with terminal access to the host can bypass the MCP admin token to delete or mutate any memory, including identity and relationship memories that are protected under the proposal workflow. The current mitigation is that the dashboard is typically only started on demand and runs on localhost by default, but the `LIBRARIAN_PUBLISHED_HOST` setting in `.env` binds it to a Tailscale IP.
