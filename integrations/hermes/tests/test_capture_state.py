"""Per-session capture state — the adapter's only durable auto-capture state.

Keyed by the Hermes session id (NEVER $USER / cwd, so N concurrent same-machine
sessions get N distinct state files). Records, per session:
  - seq:     the monotonic delta counter for the /transcript contract;
  - private: whether the previous turn left an open [private=on] span
             (carry-forward across turns / process restarts).

Unlike the Claude cursor there is NO byte offset — both turn halves are handed in
directly, so there is nothing to re-read. The state is non-critical: a lost file
re-starts at seq 0 / public, and idempotency rests on the server/curator dedup.
Every read is fail-soft (a missing/corrupt file reads as a fresh start).
"""

from __future__ import annotations

import json
from pathlib import Path

from librarian.capture_state import (
    capture_state_path,
    prune_old_state,
    read_capture_state,
    write_capture_state,
)


def test_fresh_read_when_no_file(tmp_path: Path) -> None:
    state = read_capture_state(str(tmp_path), "sess-1")
    assert state == {"seq": 0, "private": False}


def test_write_then_read_round_trips(tmp_path: Path) -> None:
    write_capture_state(str(tmp_path), "sess-1", {"seq": 4, "private": True})
    assert read_capture_state(str(tmp_path), "sess-1") == {"seq": 4, "private": True}


def test_state_is_keyed_per_session_no_collision(tmp_path: Path) -> None:
    # Two concurrent same-machine sessions must not share state.
    write_capture_state(str(tmp_path), "sess-a", {"seq": 1, "private": False})
    write_capture_state(str(tmp_path), "sess-b", {"seq": 9, "private": True})
    assert read_capture_state(str(tmp_path), "sess-a") == {"seq": 1, "private": False}
    assert read_capture_state(str(tmp_path), "sess-b") == {"seq": 9, "private": True}


def test_corrupt_file_reads_as_fresh_start(tmp_path: Path) -> None:
    path = capture_state_path(str(tmp_path), "sess-1")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ not json", encoding="utf-8")
    assert read_capture_state(str(tmp_path), "sess-1") == {"seq": 0, "private": False}


def test_negative_or_non_int_seq_normalises_to_zero(tmp_path: Path) -> None:
    path = capture_state_path(str(tmp_path), "sess-1")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"seq": -5, "private": "yes"}), encoding="utf-8")
    assert read_capture_state(str(tmp_path), "sess-1") == {"seq": 0, "private": False}


def test_hostile_session_id_cannot_traverse_out_of_capture_dir(tmp_path: Path) -> None:
    path = capture_state_path(str(tmp_path), "../../etc/passwd")
    resolved = path.resolve()
    capture_dir = (tmp_path / "librarian-plugin" / "capture").resolve()
    assert str(resolved).startswith(str(capture_dir)), resolved


def test_write_is_atomic_no_torn_file_on_concurrent_read(tmp_path: Path) -> None:
    # A second write replaces cleanly; the file is always valid JSON.
    write_capture_state(str(tmp_path), "sess-1", {"seq": 1, "private": False})
    write_capture_state(str(tmp_path), "sess-1", {"seq": 2, "private": True})
    raw = capture_state_path(str(tmp_path), "sess-1").read_text(encoding="utf-8")
    assert json.loads(raw) == {"seq": 2, "private": True}


def test_write_failure_is_swallowed(tmp_path: Path) -> None:
    # A non-writable home must not raise out of the hook (fail-soft); a lost
    # state file only costs an idempotent re-ship next turn.
    bogus = tmp_path / "file-not-a-dir"
    bogus.write_text("x", encoding="utf-8")
    # Using a file as the home dir makes mkdir fail — must not raise.
    write_capture_state(str(bogus), "sess-1", {"seq": 1, "private": False})


def test_prune_old_state_drops_stale_keeps_fresh(tmp_path: Path) -> None:
    import os
    import time

    write_capture_state(str(tmp_path), "stale", {"seq": 1, "private": False})
    write_capture_state(str(tmp_path), "fresh", {"seq": 1, "private": False})
    stale = capture_state_path(str(tmp_path), "stale")
    old = time.time() - 30 * 24 * 60 * 60
    os.utime(stale, (old, old))
    prune_old_state(str(tmp_path), max_age_s=7 * 24 * 60 * 60)
    assert not stale.exists()
    assert capture_state_path(str(tmp_path), "fresh").exists()


def test_prune_is_fail_soft_when_dir_absent(tmp_path: Path) -> None:
    # No capture dir yet — nothing to prune, never raises.
    prune_old_state(str(tmp_path / "nope"), max_age_s=1)
