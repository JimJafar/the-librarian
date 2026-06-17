"""sync_turn — the per-turn auto-capture hook on the provider.

The installed Hermes agent invokes ``provider.sync_turn(user_content,
assistant_content, *, session_id=..., messages=...)`` after every completed turn
(MemoryManager.sync_all → on a background worker), handing over BOTH halves of
the turn + the stable session id. This adapter ships that as a per-turn delta to
POST /transcript, mirroring the Claude adapter's guarantees:

- per-turn delta built O(1) from the in-payload turn (no cursor, no re-read);
- forward-only private skip (a [private=on] turn + successors never ship);
- conv_id = the Hermes session id (never $USER/cwd → no concurrent collision);
- fail-soft (never raises out of the hook, never blocks the turn);
- default-on, suppressed under private mode + LIBRARIAN_AUTO_SAVE=false;
- inert when the server intake gate is off; advance seq only on a 2xx ack.
"""

from __future__ import annotations

import json
from pathlib import Path

from _helpers import ENDPOINT, TOKEN

from librarian.capture_state import read_capture_state
from librarian.provider import LibrarianConfig, LibrarianProvider


class CaptureClient:
    """A fake client that records post_transcript calls and returns a canned ack."""

    def __init__(self, ack: dict | None = None, fail: bool = False) -> None:
        self.posts: list[dict] = []
        self._ack = ack if ack is not None else {"ok": True, "status": 200, "accepted": True}
        self._fail = fail

    def post_transcript(self, payload: dict) -> dict:
        self.posts.append(payload)
        if self._fail:
            from librarian.client import LibrarianClientError

            raise LibrarianClientError("network", "down")
        return self._ack


def _provider(home: Path, client: CaptureClient, *, env: dict | None = None) -> LibrarianProvider:
    config = LibrarianConfig(endpoint=ENDPOINT, token=TOKEN)
    p = LibrarianProvider(client=client, config=config, env=env if env is not None else {})
    p.initialize("20260617_abc123", hermes_home=str(home))
    return p


# ---- happy path: a public turn ships and advances seq ----


def test_public_turn_posts_both_halves_with_session_id_as_conv_id(tmp_path: Path) -> None:
    client = CaptureClient()
    p = _provider(tmp_path, client)
    p.sync_turn("what is the deploy command?", "run make deploy", session_id="20260617_abc123")
    assert len(client.posts) == 1
    body = client.posts[0]
    assert body["conv_id"] == "20260617_abc123"  # the Hermes session id, NOT $USER/cwd
    assert body["harness"] == "hermes"
    assert body["seq"] == 1
    assert body["turns"] == [
        {"role": "user", "text": "what is the deploy command?"},
        {"role": "assistant", "text": "run make deploy"},
    ]


def test_seq_increments_across_turns(tmp_path: Path) -> None:
    client = CaptureClient()
    p = _provider(tmp_path, client)
    p.sync_turn("q1", "a1", session_id="20260617_abc123")
    p.sync_turn("q2", "a2", session_id="20260617_abc123")
    assert [post["seq"] for post in client.posts] == [1, 2]


def test_payload_is_contract_serialisable(tmp_path: Path) -> None:
    client = CaptureClient()
    p = _provider(tmp_path, client)
    p.sync_turn("q", "a", session_id="20260617_abc123")
    # The body must round-trip JSON (it goes on the wire to the server).
    json.dumps(client.posts[0])


# ---- conv_id falls back to the initialize session id ----


def test_conv_id_uses_initialize_session_id_when_hook_omits_it(tmp_path: Path) -> None:
    client = CaptureClient()
    p = _provider(tmp_path, client)
    p.sync_turn("q", "a")  # no session_id kwarg
    assert client.posts[0]["conv_id"] == "20260617_abc123"


def test_no_conv_id_anywhere_is_a_clean_noop(tmp_path: Path) -> None:
    client = CaptureClient()
    config = LibrarianConfig(endpoint=ENDPOINT, token=TOKEN)
    p = LibrarianProvider(client=client, config=config, env={})
    # never initialized with a session id, and the hook omits it
    p.sync_turn("q", "a", session_id="")
    assert client.posts == []


# ---- private mode: forward-only skip, carry-forward, never retroactive ----


def test_private_on_turn_does_not_ship(tmp_path: Path) -> None:
    client = CaptureClient()
    p = _provider(tmp_path, client)
    p.sync_turn("[librarian:private=on] my secret", "ok", session_id="20260617_abc123")
    assert client.posts == []  # nothing public to ship
    # The open span is persisted so the NEXT clean turn is still private.
    assert read_capture_state(str(tmp_path), "20260617_abc123")["private"] is True


def test_carry_forward_keeps_next_turn_private_until_off(tmp_path: Path) -> None:
    client = CaptureClient()
    p = _provider(tmp_path, client)
    p.sync_turn("[librarian:private=on] secret", "ok", session_id="20260617_abc123")
    p.sync_turn("still secret stuff", "mm", session_id="20260617_abc123")  # no marker → private
    p.sync_turn("[librarian:private=off] resume", "back", session_id="20260617_abc123")
    p.sync_turn("public again", "sure", session_id="20260617_abc123")
    # Only the last (post-off) turn shipped — private turns never retroactively sent.
    assert len(client.posts) == 1
    assert client.posts[0]["turns"] == [
        {"role": "user", "text": "public again"},
        {"role": "assistant", "text": "sure"},
    ]


def test_private_then_public_never_ships_the_private_turns(tmp_path: Path) -> None:
    client = CaptureClient()
    p = _provider(tmp_path, client)
    p.sync_turn("[librarian:private=on] sensitive", "noted", session_id="s")
    p.sync_turn("[librarian:private=off] done", "ok", session_id="s")
    p.sync_turn("a normal question", "a normal answer", session_id="s")
    assert all("sensitive" not in json.dumps(post) for post in client.posts)
    assert len(client.posts) == 1


# ---- env gate: LIBRARIAN_AUTO_SAVE=false suppresses ----


def test_auto_save_false_suppresses_capture(tmp_path: Path) -> None:
    client = CaptureClient()
    p = _provider(tmp_path, client, env={"LIBRARIAN_AUTO_SAVE": "false"})
    p.sync_turn("q", "a", session_id="s")
    assert client.posts == []


def test_auto_save_default_on(tmp_path: Path) -> None:
    client = CaptureClient()
    p = _provider(tmp_path, client, env={})  # unset → on
    p.sync_turn("q", "a", session_id="s")
    assert len(client.posts) == 1


def test_auto_save_other_values_stay_on(tmp_path: Path) -> None:
    for val in ("true", "1", "", "yes"):
        client = CaptureClient()
        p = _provider(tmp_path, client, env={"LIBRARIAN_AUTO_SAVE": val})
        p.sync_turn("q", "a", session_id="s")
        assert len(client.posts) == 1, val


# ---- advance only on a 2xx ack ----


def test_seq_held_when_ship_not_acked(tmp_path: Path) -> None:
    client = CaptureClient(ack={"ok": False, "status": 500, "accepted": False})
    p = _provider(tmp_path, client)
    p.sync_turn("q1", "a1", session_id="s")
    # seq NOT advanced — the same delta re-ships next turn (idempotent dedup).
    assert read_capture_state(str(tmp_path), "s")["seq"] == 0
    p.sync_turn("q2", "a2", session_id="s")
    assert client.posts[1]["seq"] == 1  # still seq 1, not 2 (the first never landed)


def test_seq_held_when_post_raises(tmp_path: Path) -> None:
    client = CaptureClient(fail=True)
    p = _provider(tmp_path, client)
    p.sync_turn("q", "a", session_id="s")  # must not raise out of the hook
    assert read_capture_state(str(tmp_path), "s")["seq"] == 0


def test_gate_off_2xx_advances_seq_but_buffers_nothing(tmp_path: Path) -> None:
    # The intake gate is off: 200 + accepted:false. A clean 2xx → advance (the
    # turn is simply not captured while disabled), no re-ship storm.
    client = CaptureClient(ack={"ok": True, "status": 200, "accepted": False, "disabled": True})
    p = _provider(tmp_path, client)
    p.sync_turn("q", "a", session_id="s")
    assert read_capture_state(str(tmp_path), "s")["seq"] == 1


# ---- explicit-end accelerator ----


def test_session_end_sets_ended_and_ships_buffer(tmp_path: Path) -> None:
    client = CaptureClient()
    p = _provider(tmp_path, client)
    p.initialize("s", hermes_home=str(tmp_path))
    p.sync_turn("bye", "goodbye", session_id="s")
    p.on_session_end([{"role": "user", "content": "bye"}])
    # The end hook ships an ended:true delta (a private-only / empty tail still
    # signals the server's settle-sweep to extract without waiting for idle).
    assert any(post.get("ended") is True for post in client.posts)


# ---- fail-soft posture ----


def test_unconfigured_provider_sync_turn_is_a_clean_noop(tmp_path: Path) -> None:
    p = LibrarianProvider(env={})  # no client, no config
    p.sync_turn("q", "a", session_id="s")  # must not raise


def test_sync_turn_with_no_public_text_does_not_post(tmp_path: Path) -> None:
    client = CaptureClient()
    p = _provider(tmp_path, client)
    p.sync_turn("", "", session_id="s")  # both halves empty → nothing to ship
    assert client.posts == []
