"""Per-session auto-capture state — the adapter's only durable capture state.

Phase 2B / T-Hermes. Records, PER SESSION (keyed by the Hermes session id):
  - ``seq``     : the adapter's monotonic delta counter for the /transcript
                  contract payload.
  - ``private`` : whether the previous turn ended inside an open ``[private=on]``
                  span (carry-forward, so an unterminated span stays private into
                  the next turn — even across a process restart within a session).

There is NO byte offset (unlike the Claude cursor): the ``sync_turn`` hook hands
the adapter both halves of the completed turn directly, so there is nothing to
re-read. The state is NON-CRITICAL: if lost, the next turn re-starts at seq 0 /
public and idempotency rests on the server/curator's fact-level dedup +
advance-on-ack. So every read is fail-soft (a missing/corrupt file reads fresh).

Concurrency: keyed by ``session_id`` ONLY (never ``$USER`` / cwd), so N
concurrent same-machine sessions get N distinct files. Pruning is AGE-BASED —
never "clear all" (that would clobber a live sibling session). Home is the
plugin's own config dir under ``$HERMES_HOME`` (sibling to ``config.json``).
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any

_SUBDIR = "capture"
_PLUGIN_DIR = "librarian-plugin"


def capture_dir(hermes_home: str) -> Path:
    """The capture-state directory under the plugin's config home
    (``$HERMES_HOME/librarian-plugin/capture/``)."""
    return Path(hermes_home) / _PLUGIN_DIR / _SUBDIR


def _safe_segment(session_id: str) -> str:
    """Reduce a session id to a single safe path segment so a hostile/odd id can't
    traverse out of ``capture/``. Mirrors the server's ``sanitizeConvId`` and the
    Claude cursor's ``safeSegment``."""
    cleaned = re.sub(r"[^a-zA-Z0-9._-]", "_", str(session_id))
    cleaned = re.sub(r"\.\.+", "_", cleaned)  # collapse any `..` run
    cleaned = re.sub(r"^\.+", "_", cleaned)  # never a leading dot
    cleaned = cleaned[:200]
    return cleaned or "unknown"


def capture_state_path(hermes_home: str, session_id: str) -> Path:
    """Absolute path of a session's capture-state file."""
    return capture_dir(hermes_home) / f"{_safe_segment(session_id)}.json"


def read_capture_state(hermes_home: str, session_id: str) -> dict[str, Any]:
    """Read a session's capture state. Fail-soft: a missing or unparseable file
    reads as a fresh start (``{"seq": 0, "private": False}``) — re-shipping is
    safe (the server/curator dedup), so this never raises."""
    fresh = {"seq": 0, "private": False}
    try:
        raw = capture_state_path(hermes_home, session_id).read_text(encoding="utf-8")
        parsed = json.loads(raw)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return fresh
    if not isinstance(parsed, dict):
        return fresh
    seq = parsed.get("seq")
    return {
        "seq": seq if isinstance(seq, int) and not isinstance(seq, bool) and seq >= 0 else 0,
        "private": parsed.get("private") is True,
    }


def write_capture_state(hermes_home: str, session_id: str, state: dict[str, Any]) -> None:
    """Persist a session's capture state atomically (tmp + rename) so a crash
    mid-write can't leave a torn file a concurrent run misreads. Fail-soft: a
    write failure is swallowed (a lost state file self-heals via re-ship +
    dedup), so it never raises out of the hook."""
    try:
        target = capture_state_path(hermes_home, session_id)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(f"{target.name}.tmp-{os.getpid()}")
        tmp.write_text(
            json.dumps({"seq": int(state.get("seq", 0)), "private": bool(state.get("private"))}),
            encoding="utf-8",
        )
        os.replace(tmp, target)
    except OSError:
        # Non-critical state; a lost file re-ships idempotently next turn.
        pass


def prune_old_state(hermes_home: str, *, max_age_s: float = 7 * 24 * 60 * 60) -> None:
    """Age-based pruning: drop state files whose mtime is older than ``max_age_s``.
    NEVER "clear all" — a fresh sibling file (a concurrently-running session) must
    survive. Fail-soft: a missing dir or an un-stat-able file is skipped."""
    directory = capture_dir(hermes_home)
    try:
        names = list(directory.iterdir())
    except OSError:
        return  # no capture dir yet — nothing to prune
    cutoff = time.time() - max_age_s
    for path in names:
        try:
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink()
        except OSError:
            # Race with a concurrent session writing/rotating — skip it.
            pass
