# Proposal: Session-Safe Fallback Capture

## Status

Parked proposal for future implementation.

## Origin

This proposal came from reviewing Shokunin's wrapper scripts, which capture console output and save fallback session logs when the memory server is unavailable. The idea is valuable for continuity, but needs stronger privacy and safety boundaries in The Librarian.

## Objective

Provide optional automatic fallback capture for agent sessions without turning terminal logs or chat transcripts into unsafe durable memory.

Fallback capture should help recover handover context after crashes, MCP outages, process exits, and context compaction. It should not silently store secrets or promote noisy logs into durable memory.

## Capture Modes

```text
off
```

No raw capture. Only explicit session events are stored.

```text
summary
```

Store agent-supplied structured summaries, checkpoints, commands, file lists, decisions, and next steps. Recommended default.

```text
log
```

Store raw or near-raw transcript/log fragments after redaction. Off by default. Excluded from durable memory recall.

## Behaviour

When the session layer exists, harness wrappers may write fallback records if MCP calls fail.

Fallback records should be:

- tied to a `session_id` where possible,
- stored as session evidence, not durable memory,
- redacted before disk write,
- searchable only through session search,
- excluded from normal durable `recall`,
- promotable only through explicit `promote_session_fact`, `remember`, or `propose_memory`.

## Redaction Requirements

Before storing any captured text, redact:

- bearer tokens,
- API keys,
- GitHub tokens,
- cookies,
- `Authorization` headers,
- private key blocks,
- `.env`-style secret assignments,
- passwords in common CLI output formats,
- connection strings with credentials,
- long high-entropy strings.

Examples:

```text
Authorization: Bearer [REDACTED]
GITHUB_TOKEN=[REDACTED]
-----BEGIN PRIVATE KEY-----[REDACTED]-----END PRIVATE KEY-----
postgres://user:[REDACTED]@host/db
```

## Storage

Possible local fallback location:

```text
~/.librarian/fallback-sessions/
  ses_123.jsonl
  ses_123.md
```

If The Librarian has its own data dir configured, fallback should prefer a subdirectory under that data dir.

Fallback JSONL event shape:

```json
{
  "type": "session.fallback_event",
  "session_id": "ses_...",
  "harness": "claude-code",
  "source_ref": "cwd:/home/jim/the-librarian",
  "capture_mode": "log",
  "summary": "Captured terminal output during MCP outage.",
  "redacted": true,
  "created_at": "2026-05-17T12:00:00Z",
  "payload": {
    "text": "...redacted text..."
  }
}
```

## Harness Wrapper Behaviour

On session start:

1. Try to call `start_session`.
2. If unavailable, create a local fallback session marker.
3. Keep `LIBRARIAN_SESSION_ID` in the environment if known.

During work:

1. Prefer structured checkpoints.
2. If raw capture is enabled, buffer and redact logs before writing.
3. Avoid excessive write volume.

On process exit:

1. Try to call `pause_session` with a summary.
2. If unavailable, write redacted fallback handover locally.
3. Do not mark as `ended` unless the agent produced an explicit end summary.

On next successful connection:

1. Offer to import fallback records.
2. Import as session evidence only.
3. Never auto-promote to durable memory.

## Security Boundaries

- Raw capture must be opt-in.
- `summary` mode should be default for most harnesses.
- Pi or constrained/unknown environments should default to `off` or `summary`, never `log`.
- Fallback files should use restrictive permissions where possible.
- Import should show counts and warnings before absorbing large fallback logs.

## Acceptance Criteria

- Redaction tests cover common secret formats.
- Fallback capture cannot create active durable memories.
- Capture mode is recorded in session metadata.
- Failed MCP writes can be recovered from local fallback files.
- Imported fallback records remain session evidence.
- Healthcheck reports whether fallback location is writable.
- Raw capture is disabled by default.

## Implementation Tasks

1. Add redaction utility and tests.
2. Add fallback writer module.
3. Add fallback import command.
4. Extend harness wrapper examples to use fallback writer.
5. Add healthcheck coverage for fallback directory writability.
6. Add docs warning against raw capture in sensitive environments.

## Open Questions

- Should fallback files live under The Librarian data dir or user home by default?
- Should fallback import be automatic for trusted local files, or always manual?
- What max size should log capture allow per session?
- Should raw log capture require admin configuration rather than per-harness opt-in?
