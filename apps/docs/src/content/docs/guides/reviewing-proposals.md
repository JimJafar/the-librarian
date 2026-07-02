---
title: Reviewing & accepting proposals
description: The everyday task — judging the curator's suggested changes and approving or rejecting them.
---

The curator does most of its filing silently. The exceptions — anything that would
**throw away or restructure** what you know — it brings to you as a **proposal**.
Working through that queue is the one recurring job The Librarian asks of you, and
it usually takes a minute or two. This guide explains how to do it well.

## Why some changes need you and others don't

The curator follows one simple rule. Safe, additive operations — creating a memory,
updating one, or merging near-duplicates — it applies on its own **when it is
confident enough**. The two operations that *lose or reshape* information —
**archiving** a memory and **splitting** one apart — are never done automatically;
they always become proposals. So does any change to a memory you have marked as
needing approval. The queue, in other words, is exactly the set of changes worth a
human glance, and nothing else.

## The workflow

1. Open **[Proposals](/dashboard/proposals/)** in the dashboard. Each card is one
   suggested change.
2. **Read the reasoning, the plan, and the diff.** The card tells you what action
   it is (Update, Merge, Split, Archive, New), why the curator suggests it, and
   shows the before-and-after. An intake card also shows the **curator's plan** —
   what it *wanted* to do ("Wanted to augment ‹Elaine› with: …"), a preview of
   the result, and how confident it was. For a merge you see every source and the
   combined result; for a split, the original and its pieces.
3. **Decide.** The buttons name their exact consequence, so there is no guessing:
   - **Approve as augment of ‹X›** / **Approve — replaces ‹X›** executes the plan
     exactly as previewed.
   - **Approve curated version** activates the curator's cleaned-up title and
     body; **Approve raw submission** files the text exactly as it arrived.
   - **Discuss this proposal** opens the curator chat grounded in the card — ask
     why, or redirect it to a different action; confirming a chat-proposed fix
     also clears the proposal.
   - **Reject** leaves everything untouched; **Reject & make an example** also
     teaches the curator (see below).
4. **Tidy up a split.** When a split has produced good replacement memories, use the
   **Archive original** button beneath them to retire the source.

## How to judge a proposal

- **Archive proposals** — ask "is this really stale or wrong?" Archiving is
  reversible (the memory moves to the [Archive](/dashboard/archive/), not oblivion),
  so you can approve with low risk and undo later.
- **Merge proposals** — check the merged text did not drop a nuance from one of the
  sources. If it reads worse than the originals, reject.
- **Split proposals** — confirm each piece stands on its own and nothing was lost in
  the division.
- **When unsure, reject.** Rejecting is always safe — it changes nothing. A fact you
  reject today can be proposed again later, or you can fix it yourself on the
  [Memories](/dashboard/memories/) page.

## Teaching the curator from what you see

A plain **Reject** is silent — the curator learns nothing from it, by design.
When a rejection is *instructive* — "stop extracting one-off task reminders from
my conversations" — use **Reject & make an example** instead. A short dialog runs:

1. Optionally note *why* it's not worth remembering.
2. The curator distills the rejection into its single **examples document** — a
   small, size-capped file of rejected-submission classes it reads before every
   intake judgment. It merges and generalises rather than piling up verbatim
   entries.
3. You see the proposed change to that document as a diff, and only your explicit
   confirm commits it — then the proposal is rejected.

Only flag the rejections bad enough to be made an example of; the document is
deliberately small (the `curator.intake.examples_max_bytes` setting, 4 KB by
default) so every entry earns its place. The document is a committed vault file
(`.curator/intake-examples.md`) — git history is its undo trail.

For broader steering ("don't merge security notes", say), the per-job
**addendum** on the [Curator](/dashboard/curator/) page is still the tool. Tuning
by reacting to real proposals — not by chasing a metric — is exactly how the
curator is meant to improve; see
[Configuring the curator](/guides/configuring-the-curator/).

## Related

- [Proposals page](/dashboard/proposals/) — the screen itself.
- [Flagged](/dashboard/flagged/) — a related queue, for memories an agent reported
  as wrong.
