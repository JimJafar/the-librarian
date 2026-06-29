---
title: Private mode
description: Pause all memory writes for part of a conversation — nothing is remembered while it's on.
---

Sometimes you want to talk to your agent without any of it being remembered. **Private
mode** does exactly that: while it is on, the agent makes **no writes** to The
Librarian — nothing is remembered, no handoff is stored, nothing is flagged.
Privacy is the point of The Librarian, so this control is deliberately simple and
always available.

## Turning it on and off

Just say so. "Go private", "off the record", or "don't remember this" turns it on;
"back on the record" turns it off. Where the `/toggle-private` command exists you
can use that too. Under the hood the agent marks the conversation with
`[librarian:private=on]` and, later, `[librarian:private=off]`.

The default, when nothing has been said, is **off** — normal operation.

## What is paused, and what isn't

- **Paused:** remembering facts, storing handoffs, and flagging memories — every
  action that *writes* to the server.
- **Still allowed:** recalling memories and searching references. You can still ask
  "what do we know about X?" while private.

There is one honest caveat worth knowing: those *read* queries (recall and
reference search) still reach the server, so the **search text appears in the
server's logs** even in private mode. Private mode stops new memories being
written; it does not make a read invisible to the server you own. If you ask, the
agent will tell you this.

## Two things to watch

- **Long conversations that get compacted.** If your tool compresses a long
  conversation and drops the private marker, the agent falls back to *off*. If you
  need a hard guarantee, avoid compaction during a private stretch.
- **Mentioning the marker counts as toggling it.** Automatic capture (and the
  server) match the literal text `[librarian:private=on]` / `[librarian:private=off]`
  anywhere in a turn — they do not try to tell a real command apart from prose that
  merely quotes it. So even *talking about* `[librarian:private=on]` mid-sentence
  pauses capture from that point, until a later turn contains the off-marker. This
  is deliberate: erring toward *not* capturing is the safe direction. If capture
  seems to have stopped, check whether a recent turn mentioned the on-marker, and
  send the off-marker to resume.

## Private mode and automatic capture

[Automatic capture](/start-here/first-run/#it-remembers-as-you-work) respects
private mode the same way — a private turn is **never** shipped, and a
private-then-public sequence never retroactively sends the private turns. In fact
capture errs *more* cautiously than the agent: when it cannot be sure whether a turn
was private, it treats it as private and skips it.
