# The Librarian

[![CI](https://github.com/JimJafar/the-librarian/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/JimJafar/the-librarian/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A portable **memory + session layer for AI agents**. The Librarian gives agents
one disciplined funnel for recalling, proposing, saving, updating, and reviewing
durable context — plus a neutral **cross-harness session-continuity layer** so
work started in one harness (Claude Code, Codex, Hermes, OpenCode, Pi) can be
handed off and resumed cleanly in another.

It runs as a small self-hosted server, reachable locally or over the network.

## Harness integrations

A standalone plugin per harness — pick yours, copy the install, set two env
vars (`LIBRARIAN_MCP_URL` + `LIBRARIAN_AGENT_TOKEN`), restart.

<p align="left">
  <a href="https://github.com/JimJafar/the-librarian-claude-plugin"><img src="https://img.shields.io/badge/Claude_Code-D97757?logo=anthropic&logoColor=white&style=for-the-badge" alt="Claude Code"></a>
  <a href="https://github.com/JimJafar/the-librarian-codex-plugin"><img src="https://img.shields.io/badge/Codex-412991?logo=openai&logoColor=white&style=for-the-badge" alt="Codex"></a>
  <a href="https://github.com/JimJafar/the-librarian-hermes-plugin"><img src="https://img.shields.io/badge/Hermes-EAB308?logo=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAHhlWElmTU0AKgAAAAgABAEaAAUAAAABAAAAPgEbAAUAAAABAAAARgEoAAMAAAABAAIAAIdpAAQAAAABAAAATgAAAAAAAABIAAAAAQAAAEgAAAABAAOgAQADAAAAAQABAACgAgAEAAAAAQAAAECgAwAEAAAAAQAAAEAAAAAAdd52hwAAAAlwSFlzAAALEwAACxMBAJqcGAAADNhJREFUeAHNmgnwVVUdx8EVN8A9MDZF1FRcUMg0Agwly9DJkRnHNMswKzFHcxxcMgeVcptyJVNKCxX3PRgXRM1tcAEVF%2FhTKIIisoigsvX5PO55nv%2F93%2Ft%2F974%2Ff%2FM783lnX%2B655%2FzOOe%2B9tm2%2BRK1Zs2YLmusM3aELDIbvwVKYAE%2FCm%2FBW27Zt5%2BO2utq2Zgs88KbU3z1iV%2Fy7wy6wA%2BTpfRJegoeFwXg7L2NL41tlAHjwXnSsD2wDH8IbMIMH%2BRi3Demb4%2BwIQ%2BAEcGDy5OyYCFdT%2FrG8TF%2BJeB7sYLgdFiV8iPsRzIWX4DoYGHeWcHsYCUuhOa0m8Q7YLS7%2FlfDTqYEwAYrqATL2jjtPuD%2FMLlCBg%2FqzuOz%2FzU9HesBNsBLKypnx07jzhHtDkUGwrUth%2Fbj8l%2Bqn8RPAqd1SnR93nMoOAJdQEY0h0wZx%2BVb302BHGAvrUmfHHafi40tU%2Fnvytooxj%2FtU8dPQTvBcic41l%2FXzJHEJrv4fxQ0SHpek5zkrkoS%2F4Q6Iy5bxr1c0M424f3tY6Vu0TEY%2B9%2FegZ%2FGcDAfBReAO0Qk3aCSej0Igw51H3Fxwi%2B1HWbfV1hGVd4c3YBWkNZ%2BI8DbTaenwrUTcD255lQ7jdgDXsvWPiZ%2BA8IWg3AKdKUEL8RwHe4B9c7bcEJddZ34q3hT%2BBU%2FBpxDLLekOCAOjuyDOkPJPJrwPjAodxL8tuCM8BHdD1yitC%2BE54CCfDU%2FA%2B3BblMdzxOvgTrRPiC%2FqFrGg7rnPg%2Fv2AnCargGXz1jol%2FhxKum%2BiXdgO7DMkbAEZsCZ8DL0pbPn4s6BH0JHMO9voD%2F8A9pw8nuHfFfpheuhAXxI1702YxYcA9uCW%2BII8GS5bkQjXeFEcKptCUOhAd6Dx2EIuG0Nh3%2FCMPgF%2BEBtcDeBK8F6vBdUhL8zfAJprSbiBdgoyjs4yTQBdyS43JwRGsGH4d9gOeX22SWULeI2u31Q2U%2Bo5DWYl7wN3%2FoR4HH0QRgEf4Hl0Bl6wtHg238cjHdKj4fpYLpteke4AvaHtFYR0Y%2F2pphAHzbDmQY9YBl8CluBckaa3%2FaCTqfs5SFQy80dABremsL3wH3wMmwJE8EHHACme6tbBB3Bh7KzdrAdBLlcVsIr0B1ehw6wJzigWTqDh7gsJNCXG%2FGfEMI1XG%2BRDuCKGvkqyc3ZgMPJ4Rs7A3ygpfAmHJCEcSrqFjyJGz%2B8UQ7yhrCfAeQaryWXlTOqL%2BwEDqADmfvCSAvaC4%2Flng4Rdbl04F5YDmF94S2sjwvnzM44jeg7o6T78Mc7UK27R3X21Hr4zClIY05p16dvs8iop9uZSYQzpl458xaD9Wj5t4GNIehjPJ%2BEQIZ7KM9QNaQZ6dWozAEg1Q5sX81V3uOWpOGqVw78QGgPXWA1PAOfgXIw5ld82R87E%2B0z1FTeAPSgZF5azUrJ0BUeBddtPfqcQhpT37z240DwobQFahMwzyoDGfLt98mIbxKV95A23BL55rTCk%2BqsxAfYFeLlZ5%2FcZYKcBR%2BFQIabtcU2yZY3AE7hIppDpoU5GY8i%2Fs%2Fgm2oNuS1%2F0EzF7gY1lTcA7u1F5Bu5GcLajMu4zw%2BFV%2BPIyF%2Fv8ghVbIHHZaJ9yFJPDGGHrIQ4boM4EPln4C%2By77pbeMQ9HkaChm9v2BpugInwDvwBzOtssF47PhuOgB0gtvAEC8nlYdvuFs6GtLYjohtMTSfUDDNym8NMaE7e0o6DXawQdwPYHq6GU8Fzure08TAsq1HiN4M%2B4A2vHn1AobeaKZjZblZfmsRR6Zk5FXuXPwUuBO8EVRHeEDaGpyGWh6l7YN9q5sRDnAP3NjSnvK%2FMvRBNaabg6HR76XCeDTDfVTA5KeCPG3MTv2VeS8IjaLxXEu%2F1dQVoD16EURC2Lae8U%2F0x8l8KbmNBLkOXRZZeIPLHMDxxX05lsqz9WZaKD8FCW2HI3MSlo15bJ4Fv8HKYB8pjqd%2FQ%2FBfOTBckzi8pOoDXZvUsdAKnrMumOvD4vTLPgCy9S6RteCR3OWXNlP8Q3wBZsn1tT66qHcnKwdt8j%2FjD4BzwcHQqeDT1jd4IHni%2BDmm5Z3t4uRp8a0%2FDJXAKdd4EseX2oOO%2BnyVnjW14MnS59YS0tiVifjoyCXuardionPQ2TqFmRWedXhdFI6lhcXtzmnsQGQ9pafntvOcEB8GlMIa63sJNS0vub4X1yvIrwB0mPZC%2B4P3hOVg3YiA0cC6JZ%2BB0iE9rpRuh%2FJ6gMWuJXqOwyyVL45rrVLNLIF2Q2h3hrZL4u3Gv4K3mGbB08bxwdxJqzsS8wkl8J9y8Y%2FG%2B9Dv3nFFqAGjE6aZRcbo9wcM7E1raec%2F8LVU48WW9DG3XjnkNlB0A16qnvAnQjYfXAHn31q1Xe9RbMCrnc3gszzqSO2v3i%2FI28pYdAKe%2FVtszwf0wEJ4Cj6OlxcDZ%2FjdKF8wu4AB8kp3U5js58aXv%2FJ6v1ZZM%2F%2BW4FQOI3yVRj5xN3eopmFHGAXA3yNK3GOxMO1B2BnROat%2BFCr2NHQae%2F7MuI1kdScf58A7CupCny7wvSHqSlnkeKDsA7u1Kw%2BVsWATagycZhD9BV0jvxSTnynrK9iGvMr%2FDCMYwncdlm7kMyjYeBsDpdATcBh5yHIQl4HcDB0FR5a3%2FeVQQnxaL1pc%2BUHkQCxocPHW7vF1vdEFv4ukFF4NLwStxqaVA%2FrsgLX%2F6Oh9aejiyXusPV%2B25%2BMMZpjoGhWcAhc0bZoAV9IKDwVnwPngbXKhbRNTnlHWPTms6EQ%2BlI%2BsMaxQnJWW%2Fhts78VedJgPgg4KXiLQ0ep1SkSMJN%2FDgU1LxRYLOlmBU4%2FwPEJgFWXt6nK%2BI3%2FNJPJgHpgs1GQAyHANZhxMHxVteLG%2BCp8cRJfzWl14yrvvx4MOviwFoTz0vgLdX1W%2Bt88VnowHgzbtGfg5eYdNyumbtpb%2BmnFfWsnIAtM6xphFwF7kdmqzXOGNBv%2BeU2fBekl%2Bb5R8%2BuoTyjQaAyEHgw2jR09orHZGE7eiFOWmVaBrMGrj02zev6%2FQJOATyTnUkFdZiludScrtdKwfd84L%2FaO1jRPoi474cpuYHZog0IPKnvcdSoTbifnDqdgRHuXuCf627ns5cSjjIk1tatj0dXFZuW6dBSxTefLukEvvoMn4VzqJPRyfxax0iLgA1PE4g7D9Esv7RYd4yGhHqpdDRGQWvIa5ymME9MiO9bJTP41dzC6OCHot9If79ZrfqDCDgNA23Ovd2DcdkcMSugU1BrYEFYHxZ%2FZF6pzITJlFwJliX6zRoMmmLk8C3Q2QLXHen%2FuCMDNLuLAOfp291AAhsBKvARNf132EpOH3ifK5R9%2FB6OuggX8EgeFr8AcQPT7CNA7Q3rvZmiBEt0HLKalSvTdXhErUfPsOx1TQa9vv5q%2BB2yNMrJAyDlv4B4vmkgXhq5rVZb7w%2FzGib%2FNImyFPmzrAbeNL8tLoLMPVWMhqOjtZ3LHiKCjLtFhgKJ0I4c5vXkS6r%2FSngznFU2YIF87u0XEoa3XiWLST8LgwAZ%2FVd8IUYEb%2Bg9Dt%2FZ4JGagScBBrBbeAWiPU4gQVxREH%2FxaFV8mv41rV86%2F5pMy1tmncWf6dQR4Z%2BVF0iz6kkrbWS1%2BI%2FBUbDLIi1iMAlkNVQnC%2F47ZRTflS1sbWd8ee0y0KmVnZPo%2F5DkjYW43aJ%2B1LxE9kWzoNat7FzyXMrFJUD27TBpAekHQMzwIFqDfnCnMkvJpWPa%2FLwcQSZ%2FKvaHWDBWP4kNgr6w%2FI4oYb%2FGdLdaXJF%2BmBInzcaiJsLWdIY%2B%2F%2FhCfBhVoYozllsv5VtuNM0MhCZHSNjdxI0FhPhEXgd3EsfhN2hjM7G2F6ULkAbbkm%2FAg3jfJgJGmjf0kEwDIy7FxrAPJ5TPLb3hvbwKJj3JEhrKhE3g7ZH49foj5iEmxcddK37JnS1C%2FMgyHXtD5hF5GzyuF0Rfpfbd8Gv1D4DbcH34XDwB43nQBnvMTZTpH0T%2FMXqt%2BCXKbF827dB%2BIl9dGYlzUVSuCvMgrSWEfFL8NuhorqBjBuBR13%2FPq8egN6wI%2FQA2wuD6syoKfLvAFPBXWUsBK1OPC6R4TUrystA4W5wJUyBV%2BFO8Fw9CMrIdWtH1Rxwers1%2BQDWtRU4I9SIvP5kxZO%2FCzhw18MboJwB18FOWWVKx1HReqANqAj%2FfVBEs8i0BNxd%2FgoXg9dfH74dHAvtIUz78ysNlPygfD9wiT4IDvbBJasonp3Kh8BKqKVZZBgL5j05boHw%2BqBt2ROsT42B%2BAQXF6npp%2BxZMBM02q0jKt8ZGiBPs0mYDhqfceBUbGSACG8IGtVb7SXujTAN2rWk15R3Gd0M50H1uN%2BSOhuVpdKNIUxVvE30O2KGwgXgicup%2Fwg06gzhQ0ENsgHcR%2BGMRo3VGaAet9aa%2Bh%2BPejfgFFcYEwAAAABJRU5ErkJggg%3D%3D&logoColor=white&style=for-the-badge" alt="Hermes"></a>
  <a href="https://www.npmjs.com/package/the-librarian-opencode-plugin"><img src="https://img.shields.io/badge/OpenCode-F38020?logo=npm&logoColor=white&style=for-the-badge" alt="OpenCode"></a>
  <a href="https://github.com/JimJafar/the-librarian-pi-extension"><img src="https://img.shields.io/badge/Pi-2563EB?style=for-the-badge" alt="Pi"></a>
</p>

<details>
<summary><strong>Claude Code</strong> · <a href="https://github.com/JimJafar/the-librarian-claude-plugin">the-librarian-claude-plugin</a></summary>

In Claude Code:

```
/plugin marketplace add JimJafar/the-librarian-claude-plugin
/plugin install the-librarian@the-librarian
```

Set `LIBRARIAN_MCP_URL` and `LIBRARIAN_AGENT_TOKEN` in your shell profile,
restart Claude Code. [Full docs →](https://github.com/JimJafar/the-librarian-claude-plugin#install)

</details>

<details>
<summary><strong>Codex</strong> · <a href="https://github.com/JimJafar/the-librarian-codex-plugin">the-librarian-codex-plugin</a></summary>

```sh
codex plugin marketplace add JimJafar/the-librarian-codex-plugin
codex plugin install the-librarian@the-librarian-codex-local
```

Set the two env vars, restart Codex, and approve the four hooks
(`SessionStart`, `UserPromptSubmit`, `PostCompact`, `Stop`) via `/hooks`.
[Full docs →](https://github.com/JimJafar/the-librarian-codex-plugin#install)

</details>

<details>
<summary><strong>Hermes</strong> · <a href="https://github.com/JimJafar/the-librarian-hermes-plugin">the-librarian-hermes-plugin</a></summary>

```sh
hermes plugins install JimJafar/the-librarian-hermes-plugin
hermes memory setup            # pick "librarian", paste the endpoint
hermes plugins enable librarian
hermes gateway restart
```

Set `LIBRARIAN_AGENT_TOKEN` in the shell `hermes gateway` runs under.
[Full docs →](https://github.com/JimJafar/the-librarian-hermes-plugin#install)

</details>

<details>
<summary><strong>OpenCode</strong> · <a href="https://github.com/JimJafar/the-librarian-opencode-plugin">the-librarian-opencode-plugin</a> · <a href="https://www.npmjs.com/package/the-librarian-opencode-plugin">npm</a></summary>

```sh
opencode plugin the-librarian-opencode-plugin
```

Then add an `mcpServers.librarian` block to your `opencode.json` (4 lines —
[shown in the plugin README](https://github.com/JimJafar/the-librarian-opencode-plugin#2-wire-the-mcp-server))
and set the two env vars. First `session.created` auto-installs the seven
`/lib-session-*` slash commands to `~/.config/opencode/commands/`.

</details>

<details>
<summary><strong>Pi</strong> · <a href="https://github.com/JimJafar/the-librarian-pi-extension">the-librarian-pi-extension</a></summary>

```sh
export LIBRARIAN_MCP_URL="https://your-librarian/mcp"
export LIBRARIAN_AGENT_TOKEN="<your-token>"
pi install git:github.com/JimJafar/the-librarian-pi-extension
```

That's it — memory tools and the session lifecycle are live.
[Full docs →](https://github.com/JimJafar/the-librarian-pi-extension#install)

</details>

## Features

- **Durable memory** — `recall` / `remember` / `verify` with categories, scoping
  (`common` vs `agent_private`), a proposal flow for protected categories, and a
  three-state (`active` / `proposed` / `archived`) model.
- **Cross-harness sessions** — start / checkpoint / pause / end / continue, with
  a handover package any harness can resume. Session history is *evidence*;
  durable facts are promoted explicitly.
- **Memory curator** — an optional scheduled LLM pass that grooms memory
  (dedupe, archive stale, refine), configured and observed from the dashboard.
- **Dashboard** — a Next.js admin cockpit (Memories, Sessions, Recall,
  Proposals, Archive, Logs, Analytics, Curator) with a ⌘K command palette.

Event-sourced and dependency-light: append-only JSONL ledgers + a generated
SQLite/FTS5 index over the built-in `node:sqlite` — no external database to run.

## Quick start

### Docker (recommended for a VPS)

```sh
cp .env.example .env   # optional — auth/secret vars auto-generate
docker compose --env-file .env -f docker/docker-compose.yml up -d --build
```

A fresh install needs **zero** auth/secret env vars: `LIBRARIAN_ADMIN_TOKEN` and
`LIBRARIAN_SECRET_KEY` auto-generate on first boot (watch the log for the
one-time values), and you enable owner login from the dashboard. Full deploy
guide: [DEPLOYMENT.md](./DEPLOYMENT.md).

### Local dev (two services)

Requirements: **Node 22.5+** and **pnpm 9.15.x** via Corepack:

```sh
corepack enable && corepack prepare pnpm@9.15.0 --activate
pnpm install
pnpm run seed                               # seed sample memories
pnpm run serve                              # mcp-server at http://127.0.0.1:3838
pnpm --filter @librarian/dashboard dev      # dashboard at http://127.0.0.1:3000
```

```sh
pnpm run healthcheck                              # local end-to-end smoke
pnpm run healthcheck -- --remote http://host:3838 # probe a deployed instance
```

## Configuration

Auth and secrets are managed from the dashboard at **`/settings/auth`** (password
and/or GitHub/Google), enforced without a redeploy. Agent tokens are
dashboard-managed too. A fresh install needs **zero** auth/secret env vars;
`LIBRARIAN_ADMIN_TOKEN` and `LIBRARIAN_SECRET_KEY` auto-generate on first boot.

For the host/port, data dir, and the legacy env-configured auth path, see
[DEPLOYMENT.md](./DEPLOYMENT.md).

## MCP tools

Agents talk to the Librarian over `/mcp` with a bearer token.

### Memory

- `start_context` — required context package for an agent.
- `recall` — search memories (`active` only by default; pass
  `include_ids: true` for `[mem_…]`-prefixed lines so callers can `verify`).
- `remember` — create an active memory, or a proposal for protected categories.
- `propose_memory` — create a proposed memory.
- `update_memory` — edit an active memory.
- `verify_memory` — record a verdict: `useful` / `not_useful` move recall rank
  by ±1 (clamped ±3); `outdated` archives the memory.
- `list_proposals` — list pending proposals.
- `archive_memory` *(admin)* — archive a memory.
- `approve_proposal` *(admin)* — activate, edit, or reject a proposal.

Memories are `active`, `proposed`, or `archived`. The `identity` and
`relationship` categories are **proposal-only**: agents propose, a human
approves.

### Sessions

- `start_session` — start a session attributed to the calling agent.
- `get_session` / `list_sessions` / `list_session_events` / `search_sessions` — reads.
- `record_session_event` — append a typed evidence event.
- `checkpoint_session` / `pause_session` / `end_session` — explicit lifecycle.
- `attach_session` / `continue_session` — cross-harness attach + handover.
- `promote_session_fact` — promote a session fact to a durable memory.

Sessions are `active`, `paused`, or `ended`. Resuming an `ended` session flips
it back to `paused`; the next recorded event flips it to `active`. Each agent
sees `common` sessions plus its own `agent_private`; admin bypasses.

## Slash commands

The canonical cross-harness surface is `/lib:session <verb>`; the contract is in
[`docs/slash-commands.md`](./docs/slash-commands.md). Each harness implements it
natively — Claude Code and OpenCode ship per-verb commands
(`/lib-session-start`, `/lib-session-resume`, …) plus `/lib-toggle-private`.

## Dashboard

The Next.js admin cockpit (port `3000`) surfaces **Memories**, **Sessions**,
**Recall** (two-pane timeline + insights), **Proposals**, **Archive**, **Logs**,
**Analytics**, and the **Curator** cockpit — reachable from a persistent top nav
and a ⌘K command palette (`?` shows shortcuts). Owner login is configured from
**Settings → Auth**; the admin token never reaches the browser.

## CLI

The `the-librarian` binary runs the full session lifecycle against a local
store, alongside `rebuild`, `seed`, `backup`/`restore`/`export`, and `auth`:

```sh
the-librarian sessions start --title "Refactor auth" --harness codex --cwd "$PWD"
the-librarian sessions list --project the-librarian
the-librarian sessions continue ses_… --format markdown
the-librarian sessions checkpoint ses_… --summary-file checkpoint.md
the-librarian sessions pause ses_…
the-librarian sessions end ses_…
the-librarian sessions search "BM25 recall" --project the-librarian

the-librarian auth status                              # configured methods (no secrets)
the-librarian auth reset-password                      # set a new owner password
the-librarian auth disable                             # break-glass: turn enforcement off
```

Every verb supports `--json`, `--agent <id>`, and `--admin`. `continue`
supports `--format prose|markdown|claude|codex|opencode|hermes|pi` and
`--no-attach`.

## Memory curator

The curator is an **optional, scheduled LLM pass** that grooms the memory store
— deduping, archiving stale entries, refining wording — configured and observed
from the dashboard **Curator** cockpit (`/curator`). The curator's LLM API
token is encrypted at rest with `LIBRARIAN_SECRET_KEY`. Spec:
[`docs/specs/done/memory-curator-spec.md`](./docs/specs/done/memory-curator-spec.md).

## Agent skill

A reusable skill lives at
[`skills/use-the-librarian/SKILL.md`](./skills/use-the-librarian/SKILL.md) —
copy it into any skill-aware agent. The Claude Code plugin ships this skill
directly.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the workspace layout, "where to
add what" recipes (new MCP tool / tRPC procedure / dashboard page / CLI verb),
and local test/lint commands.

Specs and TODOs live in [`docs/`](./docs/); completed specs are archived in
[`docs/specs/done/`](./docs/specs/done/).

## License

Apache-2.0.
