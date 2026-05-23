# Spec: Agent Naming and Caller Identity Contract

**Author:** Guybrush, with Jim
**Date:** 2026-05-23
**Status:** Draft — revised after stronger-model review

---

## 1. Purpose

Give The Librarian reliable attribution without relying on per-agent copied tokens.

Every agent or system actor that interacts with The Librarian must identify itself with a stable name. The Librarian normalises that name server-side and stores the canonical value.

Identity should be supplied out-of-band by the harness, MCP transport, CLI wrapper, dashboard session, or scheduler. The language model may be told its name for consistency, but model-supplied text is not a secure identity source.

The key separation is:

- **tokens authenticate** — is this caller allowed to use The Librarian?
- **names identify** — which agent/system actor is doing the work?

This replaces “token implies identity” as the primary attribution model.

---

## 2. Problem

Current attribution can degrade into `unknown-agent` or fragmented names because:

- shared agent tokens do not identify which agent is calling;
- per-agent token mapping is annoying to copy across machines;
- agents can omit `agent_id`;
- variant names such as `Guybrush`, `guybrush`, `guybrush `, and `Guybrush (Hermes)` can split history;
- system jobs such as future memory curation also need audit attribution.

The result is weaker visibility filtering, messier dashboards, less useful memory audit trails, and harder cross-agent handover.

---

## 3. Contract

### 3.1 Required caller identity

Every identity-bearing call to The Librarian must carry a caller identity.

For agent-facing surfaces, the compatibility field is:

```ts
agent_id: string
```

For internal/admin/system surfaces, the same canonical identity rules apply. The implementation may call it `agent_id`, `actor_id`, or `caller_id` internally, but persisted attribution should use one canonical string format.

New internal code should prefer `actor_id`/`caller_id` for “who performed this operation”. Keep `agent_id` where it already means memory/session owner.

### 3.2 Calls that must include identity

At minimum:

- `start_context`
- `recall`
- `remember`
- `propose_memory`
- `update_memory`
- `verify_memory`
- `list_proposals`
- `promote_session_fact`
- `start_session`
- `list_sessions`
- `continue_session`
- `checkpoint_session`
- `pause_session`
- `end_session`
- `record_session_event`
- CLI equivalents of the above
- dashboard/admin mutations
- scheduled/system jobs such as memory curation

Read-only public health/status endpoints do not need caller identity. Anything that reads private visibility, changes memory/session state, or writes audit events does.

### 3.3 Agent responsibility

Each agent integration must provide identity out-of-band and also tell the agent its identity explicitly:

```md
## Agent Identity

Your Librarian `agent_id` is `guybrush`.
Send this value on every Librarian MCP/CLI call.
If the conversation is private/off-record, do not call The Librarian at all.
```

Agents must not send `unknown-agent`. If an agent genuinely does not know its identity, that is an integration bug and should fail loudly.

Where possible, wrappers/transports should inject `agent_id` themselves and ignore any model-authored attempt to change it. If a raw MCP tool call still exposes `agent_id` to the model during migration, the token must restrict the allowed ids so prompt injection cannot impersonate another agent or a system actor.

### 3.4 Server responsibility

The Librarian must:

1. require identity on identity-bearing calls;
2. normalise it before use;
3. apply configured aliases;
4. reject empty/invalid results;
5. validate against token restrictions when present;
6. store the canonical value;
7. preserve enough raw/request context for audit where useful and safe.

---

## 4. Canonical name rules

### 4.1 Syntax

Canonical ids use this format:

```text
^[a-z0-9]+(-[a-z0-9]+)*$
```

Limits:

- minimum length: 1;
- maximum length: 64;
- lowercase only;
- ASCII alphanumeric plus single hyphen separators;
- no leading/trailing hyphen;
- no consecutive hyphens.

### 4.2 Normalisation algorithm

Normalisation should treat punctuation and whitespace as separators, not simply delete them. This makes `claude.code`, `claude_code`, and `Claude Code` collapse to `claude-code` rather than producing unrelated strings.

```ts
export function normaliseCallerId(raw: string): string {
  const value = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")       // drop combining marks
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!value) throw new Error("agent_id normalises to an empty value");
  if (value.length > 64) throw new Error("agent_id is too long after normalisation");
  return value;
}
```

### 4.3 Examples

| Raw input | Normalised |
|---|---|
| `Guybrush` | `guybrush` |
| ` guybrush ` | `guybrush` |
| `GUYBRUSH` | `guybrush` |
| `Claude Code` | `claude-code` |
| `claude.code` | `claude-code` |
| `codex_v2` | `codex-v2` |
| `Pi` | `pi` |
| `Guybrush (Hermes)` | `guybrush-hermes` |
| `!!!` | reject |

### 4.4 Alias mapping

Normalisation handles syntactic variation. It cannot know semantic aliases. Use an explicit alias map for those.

Example config/table:

```yaml
caller_aliases:
  guybrush-hermes: guybrush
  claude-code: claude
```

Resolution order:

```text
raw input → syntactic normalisation → alias lookup → canonical id
```

Alias targets must themselves be valid canonical ids. Alias chains should be flattened or rejected; do not allow recursive alias resolution.

Alias use should be audited because it changes attribution.

Reserved namespaces:

- `system-*` is only valid for role `system`;
- `dashboard-*` is only valid for dashboard/admin role;
- `cli` is only valid for trusted local CLI calls;
- ordinary agent tokens must not create or alias into reserved ids.

---

## 5. Authentication versus identity

### 5.1 Auth remains token-based

Existing bearer tokens continue to answer: “may this request use The Librarian?”

Examples:

- admin token: may perform admin actions;
- shared agent token: may perform agent actions and must provide `agent_id`;
- mapped agent token: may restrict which `agent_id` values are allowed.

### 5.2 Identity comes from the trusted integration boundary

The primary identity source should be a trusted integration boundary: MCP auth context, wrapper-injected environment/config, dashboard session, or scheduler config. A request body field such as `agent_id` is acceptable only when that field was injected by the wrapper/transport or is checked against a token-scoped allowlist.

Token-derived identity is a restriction or compatibility fallback during migration, not the whole attribution model.

### 5.3 Mismatch rules

If a token is bound to a specific agent id and the request also provides `agent_id`:

- normalise both;
- apply aliases;
- if they match, accept;
- if they differ, reject with a clear impersonation/mismatch error.

If a shared agent token is used:

- require an out-of-band `agent_id` from the local integration environment;
- normalise and store it;
- validate it against an optional allowlist for that token/config;
- reject reserved system/admin ids unless the token has that role/capability.

If an admin token is used:

- require an audit actor id for mutations, e.g. `dashboard-admin`, `jim-admin`, or `migration`;
- admin may act on behalf of another agent only when the operation explicitly supports that.

### 5.4 Actor versus owner/subject

Do not overload one field for both audit attribution and data ownership.

- `actor_id` / `caller_id`: who performed this operation.
- `owner_agent_id`: which agent owns an agent-private memory/session.
- `subject_agent_id`: which agent a filter/admin action is operating on.

Examples:

- Guybrush creates a common memory: `actor_id = guybrush`, `owner_agent_id = null`.
- Guybrush creates an agent-private memory: `actor_id = guybrush`, `owner_agent_id = guybrush`.
- Dashboard admin archives Guybrush’s private stale memory: `actor_id = dashboard-admin`, `owner_agent_id = guybrush`.
- Memory curator proposes a common cleanup: `actor_id = system-memory-curator`, `owner_agent_id = null`.

Visibility filtering should use owner/subject fields. Audit trails should use actor fields.

---

## 6. System actors

Scheduled/internal jobs need names too. They are not human agents, but they still mutate memory/session state and need audit attribution.

Canonical system actor ids:

| Actor | Canonical id | Use |
|---|---|---|
| Memory curator | `system-memory-curator` | Scheduled memory curation. |
| Scheduler | `system-scheduler` | Generic scheduled lifecycle jobs. |
| Migration scripts | `system-migration` | One-off migrations/backfills. |
| Dashboard admin | `dashboard-admin` | Dashboard-initiated admin actions when no specific user auth exists. |
| CLI operator | `cli` | Direct local CLI calls where no agent identity is supplied but the caller is explicitly the CLI. |

If the dashboard later has user accounts, replace broad `dashboard-admin` with stable user actor ids such as `jim-admin`. Do not silently overload `guybrush` or another agent id for human/admin actions.

Persist actor role/kind (`agent`, `admin`, `system`, `cli`) alongside the canonical id where schema changes are feasible. If the existing schema cannot add this immediately, enforce the role at resolver boundaries and include it in audit metadata.

---

## 7. API and implementation changes

### 7.1 Core resolver

Add one resolver used by MCP, CLI, dashboard, and internal jobs:

```ts
interface ResolveCallerInput {
  rawAgentId?: string;
  authenticatedAgentId?: string;
  injectedAgentId?: string;
  role: "agent" | "admin" | "system";
  allowedAgentIds?: string[];
  allowMissingDuringMigration?: boolean;
}

interface ResolvedCaller {
  actor_id: string;
  raw_id?: string;
  injected_id?: string;
  authenticated_id?: string;
  role: "agent" | "admin" | "system";
  alias_applied?: string;
}
```

The resolver:

1. prefers a trusted injected id over a model/request body id;
2. in soft-migration mode may fall back to authenticated id;
3. never falls back to `unknown-agent` for new hard-mode calls;
4. normalises;
5. applies aliases;
6. validates token binding, allowlists, reserved namespaces, and role mismatch;
7. returns a canonical caller object.

### 7.2 MCP layer

Current MCP visibility code pins `agent_id` from auth context when an agent-token map is used. Change this behaviour:

- do not silently overwrite a supplied `agent_id`;
- resolve caller identity once at dispatch/tool-entry;
- reject mismatches between auth-bound id and request id;
- reject ordinary agent attempts to use reserved system/admin ids;
- pass the resolved canonical id to store methods;
- update tool input schemas so identity-bearing tools require `agent_id` unless a transport-level identity envelope is implemented.

Session lifecycle MCP tools should accept caller identity too. A checkpoint/pause/end event should record who performed it, not merely reuse whoever created the session.

Longer-term, prefer a transport-level identity envelope over a model-visible `agent_id` argument. Until that exists, the MCP layer must treat `agent_id` as untrusted input checked against the authenticated/injected context.

### 7.3 CLI

CLI commands should support:

```text
--agent <id>
LIBRARIAN_AGENT_ID=<id>
```

Rules:

- mutating CLI commands require an identity from `--agent`, env, or an explicit system default;
- hook scripts must pass the real agent id, e.g. `--agent guybrush`, `--agent claude`, `--agent codex`;
- direct manual CLI use may default to `cli`, but that should be treated as a real actor id, not “unknown”.

The current fallback to `cli` is acceptable only for local operator actions, not for harness integration scripts that know the agent name.

### 7.4 Store layer

All persisted attribution fields should contain canonical ids:

- `memories.agent_id`
- `sessions.created_by_agent_id`
- `sessions.current_agent_id`
- session event payload `agent_id`
- proposal/update/verification event actor ids
- future curation run actor ids

If raw ids are preserved, store them in metadata/audit payloads, not as query keys.

### 7.5 Dashboard/tRPC

Dashboard and tRPC changes:

- agent filter dropdown lists canonical ids only;
- aliases can be shown as secondary text if stored;
- `unknown-agent` is visually marked as legacy/unattributed;
- system actors are grouped separately from normal agents;
- admin mutations record `dashboard-admin` or authenticated user actor id;
- constrained fields use dropdowns/toggles, not free text, where possible.

---

## 8. Canonical names for current harnesses

| Harness/agent | Canonical id | Notes |
|---|---|---|
| Hermes Guybrush | `guybrush` | Jim’s current Discord/Hermes agent. |
| Hermes Bede | `guybrush` | If running as a distinct agent identity. |
| Claude Code | `claude` | Use alias `claude-code → claude` only if Jim wants all Claude Code history collapsed under `claude`. |
| Codex | `codex` | Stable across Codex CLI/app. |
| OpenCode | `opencode` | Stable across OpenCode surfaces. |
| Pi | `pi` | Until a more specific Pi agent name exists. |
| Memory curator | `system-memory-curator` | Internal scheduled job. |
| CLI | `cli` | Manual local operator calls only. |

All variants of `bede` (e.g Bede, bede_a etc.) should be renamed to `guybrush`.

If Jim creates named agents, the agent’s name wins: `marvin`, `batman`, etc. Harness name is not necessarily the agent name.

---

## 9. Migration plan

### Phase 0 — Baseline audit

- List existing distinct `agent_id`, `created_by_agent_id`, and `current_agent_id` values.
- Run the normaliser in dry-run mode to show collapse groups.
- Identify obvious aliases and collisions.
- Leave `unknown-agent` untouched unless there is strong external evidence.

### Phase 1 — Add resolver and soft warnings

- Add `normaliseCallerId` and resolver tests.
- Add alias config/table.
- Update MCP/CLI/dashboard paths to call the resolver.
- If `agent_id` is missing, accept only in soft mode and log a warning with tool name/harness/source.
- If auth-bound id and supplied id mismatch, reject immediately.

### Phase 2 — Update integrations

Update every integration instruction file:

- `integrations/claude-code/CLAUDE.md`
- `integrations/codex/AGENTS.md`
- `integrations/hermes/AGENTS.append.md`
- `integrations/pi/AGENTS.md`
- `integrations/opencode/AGENTS.md`

Add explicit identity instructions and update examples to include `agent_id` / `--agent`.

Update hook scripts/wrappers to pass the correct id.

### Phase 3 — Backfill canonical ids

Apply a migration that:

- normalises all non-empty existing ids;
- applies approved alias mappings;
- records before/after counts;
- does not guess `unknown-agent` rows;
- writes an audit event or migration log.

Potential manual mapping file:

```yaml
backfill_aliases:
  Guybrush: guybrush
  guybrush-hermes: guybrush
  Claude Code: claude
```

### Phase 4 — Hard enforcement

- Make `agent_id` required in schemas for identity-bearing tools.
- Remove new-call fallback to `unknown-agent`.
- Keep `unknown-agent` only as a legacy value visible in historical data.
- Add dashboard warning if new `unknown-agent` rows appear, because that indicates a bug.

---

## 10. Collision handling

If two distinct callers normalise to the same id, do not let both proceed under that id accidentally.

Examples:

- `pi` the harness and a hypothetical agent named `Pi` are the same canonical id;
- two different “claude” integrations might need `claude` vs `claude-reviewer` if Jim wants them distinct.

Policy:

1. Detect collisions during integration setup and migration dry-run.
2. Ask Jim which canonical ids should exist.
3. Add aliases only when two names genuinely refer to the same actor.
4. Rename one actor when they are distinct.

---

## 11. Testing strategy

### Unit tests

- normalisation lowercases and trims;
- punctuation/whitespace become hyphens;
- repeated hyphens collapse;
- empty results reject;
- overlong ids reject;
- normalisation is idempotent;
- aliases apply after normalisation;
- alias loops reject;
- token-bound id mismatch rejects;
- shared token requires supplied id;
- admin mutation requires audit actor id.

### Integration tests

- MCP `remember` without `agent_id` fails in hard mode;
- MCP `checkpoint_session` records supplied caller id;
- CLI mutating command uses `--agent` or `LIBRARIAN_AGENT_ID`;
- harness hook script passes canonical id;
- dashboard filter deduplicates variant names;
- `unknown-agent` cannot be produced by new calls in hard mode;
- system memory curator writes actor `system-memory-curator`.

### Migration tests

- dry-run shows variant collapse groups;
- backfill normalises existing rows;
- approved aliases are applied;
- unknown rows remain untouched;
- collision groups require explicit mapping.

---

## 12. Success criteria

- [ ] Every identity-bearing MCP/CLI/dashboard/system call resolves a canonical caller id.
- [ ] New calls cannot create `unknown-agent` attribution.
- [ ] Normalisation collapses simple variants such as `Guybrush`, `guybrush`, and ` guybrush `.
- [ ] Alias mapping handles semantic variants only when configured.
- [ ] Tokens authenticate but do not silently define identity.
- [ ] Token-bound identity mismatches are rejected.
- [ ] Session lifecycle events record the acting caller, not only the session creator.
- [ ] System jobs have explicit system actor ids.
- [ ] Dashboard filters and displays canonical ids cleanly.
- [ ] Existing data is backfilled without guessing unknown rows.

---

## 13. Non-goals

- Do not build a full user-account/SSO system.
- Do not use agent names as authentication secrets.
- Do not infer identities from model names or user-agent strings.
- Do not automatically map `unknown-agent` rows to named agents without evidence.
- Do not expose private/off-record session markers through this contract; private mode means no Librarian call.

---

## 14. Open questions

1. Should `claude-code` be aliased to `claude`, or should the canonical id remain `claude-code` for precision?
2. Should dashboard admin actions use `dashboard-admin` until user auth exists, or `jim-admin` now?
3. Should system actors share the same `agent_id` column or should the schema grow an explicit `actor_kind` field?
4. How long should soft-warning mode last before hard enforcement?
5. Should `cli` remain an allowed default for manual local CLI mutations, or should even manual CLI require `--agent`?
