"""Pure capture transforms — turn-pair → typed turns, private-span filter, payload.

The Hermes adapter receives BOTH halves of a completed turn directly from the
``sync_turn`` hook (user_content + assistant_content), so there is no cursor and
no re-read: the delta is built O(1) from the in-payload turn. These transforms
own that build, mirroring the Claude adapter's *guarantees* in Python:

- private-mode is forward-only — a turn carrying ``[librarian:private=on]`` (and
  every turn until ``[librarian:private=off]``) is skipped, and once skipped is
  NEVER retroactively shipped;
- the payload is the uniform, harness-agnostic
  ``{conv_id, harness:"hermes", seq, turns:[{role,text,ts?}], ended?}`` the
  server's /transcript contract expects.

Nothing here does IO or network — fully unit-testable and fail-soft.
"""

from __future__ import annotations

from librarian.capture import (
    PRIVATE_OFF,
    PRIVATE_ON,
    build_payload,
    filter_private_exchange,
    filter_private_turns,
    turn_pair_to_turns,
)

# ---- turn_pair_to_turns: both halves → [user, assistant] ----


def test_turn_pair_yields_user_then_assistant_in_order() -> None:
    turns = turn_pair_to_turns("hello there", "hi, how can I help?")
    assert turns == [
        {"role": "user", "text": "hello there"},
        {"role": "assistant", "text": "hi, how can I help?"},
    ]


def test_turn_pair_stamps_timestamp_when_supplied() -> None:
    turns = turn_pair_to_turns("q", "a", ts="2026-06-17T10:00:00Z")
    assert turns[0]["ts"] == "2026-06-17T10:00:00Z"
    assert turns[1]["ts"] == "2026-06-17T10:00:00Z"


def test_turn_pair_drops_empty_halves() -> None:
    # A tool-only assistant step or an empty user half yields nothing for that side.
    assert turn_pair_to_turns("", "answer only") == [{"role": "assistant", "text": "answer only"}]
    assert turn_pair_to_turns("question only", "") == [{"role": "user", "text": "question only"}]
    assert turn_pair_to_turns("", "") == []


def test_turn_pair_strips_surrounding_whitespace() -> None:
    turns = turn_pair_to_turns("  hi  ", "  hey  ")
    assert turns[0]["text"] == "hi"
    assert turns[1]["text"] == "hey"


def test_turn_pair_coerces_non_string_halves_to_empty() -> None:
    # sync_turn is typed str/str, but a misbehaving harness could hand a non-str;
    # treat anything non-string as empty rather than crashing the hook.
    assert turn_pair_to_turns(None, "ok") == [{"role": "assistant", "text": "ok"}]  # type: ignore[arg-type]
    assert turn_pair_to_turns(["x"], 42) == []  # type: ignore[arg-type]


# ---- filter_private_turns: forward-only private skip ----


def test_keeps_all_turns_when_no_marker() -> None:
    turns = [
        {"role": "user", "text": "what is the deploy command?"},
        {"role": "assistant", "text": "run make deploy"},
    ]
    kept, end_private = filter_private_turns(turns, start_private=False)
    assert kept == turns
    assert end_private is False


def test_private_on_skips_that_turn_and_following_turns() -> None:
    turns = [
        {"role": "user", "text": f"{PRIVATE_ON} my secret api key is sk-123"},
        {"role": "assistant", "text": "noted, staying private"},
    ]
    kept, end_private = filter_private_turns(turns, start_private=False)
    assert kept == []
    assert end_private is True  # span stays open into the next turn (carry-forward)


def test_carry_forward_open_span_skips_a_clean_next_turn() -> None:
    # The previous run ended inside an open private span: a turn with NO marker is
    # still private until an explicit =off closes it.
    turns = [{"role": "user", "text": "still talking about the secret"}]
    kept, end_private = filter_private_turns(turns, start_private=True)
    assert kept == []
    assert end_private is True


def test_private_off_closes_the_span_but_skips_the_boundary_turn() -> None:
    # The =off turn itself is a boundary (carries no durable fact) → skipped; the
    # span is closed so a later turn would be kept.
    turns = [{"role": "user", "text": f"{PRIVATE_OFF} ok we can resume"}]
    kept, end_private = filter_private_turns(turns, start_private=True)
    assert kept == []
    assert end_private is False


def test_public_turn_after_off_is_kept_never_retroactively_private() -> None:
    turns = [
        {"role": "user", "text": f"{PRIVATE_OFF}"},
        {"role": "assistant", "text": "back to normal"},
    ]
    kept, end_private = filter_private_turns(turns, start_private=True)
    assert kept == [{"role": "assistant", "text": "back to normal"}]
    assert end_private is False


def test_last_marker_in_a_turn_wins() -> None:
    # A turn that ends by re-opening privacy stays private into the next turn.
    turns = [{"role": "user", "text": f"{PRIVATE_OFF} ... {PRIVATE_ON}"}]
    kept, end_private = filter_private_turns(turns, start_private=False)
    assert kept == []
    assert end_private is True


# ---- filter_private_exchange: the Hermes exchange-granular boundary ----


def test_exchange_with_no_marker_keeps_both_halves() -> None:
    turns = [{"role": "user", "text": "q"}, {"role": "assistant", "text": "a"}]
    kept, end_private = filter_private_exchange(turns, start_private=False)
    assert kept == turns
    assert end_private is False


def test_exchange_with_on_in_user_skips_the_whole_exchange_including_reply() -> None:
    # The user opened privacy mid-exchange: the assistant reply is responding to
    # now-private content, so the WHOLE exchange is skipped (not just the user half).
    turns = [
        {"role": "user", "text": f"{PRIVATE_ON} my secret"},
        {"role": "assistant", "text": "here is a reply that references the secret"},
    ]
    kept, end_private = filter_private_exchange(turns, start_private=False)
    assert kept == []
    assert end_private is True


def test_exchange_with_off_in_user_skips_the_whole_boundary_exchange() -> None:
    # The off-marker exchange is a boundary; its assistant reply is part of the
    # boundary, so nothing ships. The span closes for the NEXT clean exchange.
    turns = [
        {"role": "user", "text": f"{PRIVATE_OFF} ok resume"},
        {"role": "assistant", "text": "welcome back"},
    ]
    kept, end_private = filter_private_exchange(turns, start_private=True)
    assert kept == []
    assert end_private is False


def test_exchange_carry_forward_open_span_skips_a_clean_exchange() -> None:
    turns = [{"role": "user", "text": "still on the secret"}, {"role": "assistant", "text": "mm"}]
    kept, end_private = filter_private_exchange(turns, start_private=True)
    assert kept == []
    assert end_private is True


def test_exchange_last_marker_across_halves_wins() -> None:
    # off in the user half, on in the assistant half → ends private (re-opened).
    turns = [
        {"role": "user", "text": f"{PRIVATE_OFF} done"},
        {"role": "assistant", "text": f"actually {PRIVATE_ON}"},
    ]
    kept, end_private = filter_private_exchange(turns, start_private=False)
    assert kept == []
    assert end_private is True


# ---- build_payload: the uniform /transcript contract shape ----


def test_build_payload_has_the_uniform_contract_shape() -> None:
    payload = build_payload(
        conv_id="20260617_abc123",
        seq=3,
        turns=[{"role": "user", "text": "q"}, {"role": "assistant", "text": "a"}],
    )
    assert payload == {
        "conv_id": "20260617_abc123",
        "harness": "hermes",
        "seq": 3,
        "turns": [{"role": "user", "text": "q"}, {"role": "assistant", "text": "a"}],
    }


def test_build_payload_omits_ended_unless_true() -> None:
    payload = build_payload(conv_id="c", seq=1, turns=[])
    assert "ended" not in payload
    ended = build_payload(conv_id="c", seq=1, turns=[], ended=True)
    assert ended["ended"] is True
