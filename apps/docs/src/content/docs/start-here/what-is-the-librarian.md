---
title: What is The Librarian?
description: A plain-language orientation — what The Librarian is, who it is for, and when you would reach for it.
---

The Librarian gives your AI coding agents a **shared, lasting memory** and a way
to **hand work from one agent to another**. Today, most agents forget everything
the moment a conversation ends, and nothing they learn carries across to the next
tool you use. The Librarian fixes both problems with one small server that all of
your agents talk to.

## What it actually is

Under the hood it is a collection of plain Markdown files kept in a Git
repository — a "vault". There are three kinds of note:

- **Memories** — durable facts, decisions, and preferences worth keeping ("we
  deploy on Fridays", "the API base URL is …", "Jim prefers tabs").
- **Handoffs** — a written summary of work in progress, so a different agent can
  pick it up where you left off.
- **References** — long background documents (a spec, a manual, a paper) you
  upload once and let agents search.

A built-in **curator** tends this collection as it grows: it files each new
memory where it belongs, links related notes together, removes duplicates, and
keeps the whole thing tidy for *finding things later*, not just storing them.

Because everything is plain files in Git, nothing is locked inside a database.
You can read, edit, and reorganise your memories yourself — in The Librarian's
own dashboard, or in any Markdown editor — and Git keeps the full history.

## Who it is for

This site is written for the person **running** The Librarian — for yourself or
for a team — not for someone reading its source code. You do not need to be a
developer to follow it. If you can install a desktop app and copy a couple of
values between two windows, you can run The Librarian.

## When you would reach for it

- You use more than one AI coding tool (say Claude Code and Codex) and want them
  to share what they know.
- You are tired of re-explaining the same project facts at the start of every
  session.
- You want to stop a long task in one tool and resume it cleanly in another.
- You want a place you control where your agents' memory lives — plain files, on
  your own server, that you can read and back up.

## How agents reach it

The Librarian runs as one small self-hosted server. Each AI tool ("harness")
connects to it the same way, gaining seven simple actions — like *recall*,
*remember*, and *hand off* — plus a short briefing document (the **primer**) that
teaches the agent how and when to use them. We support five harnesses today:
**Claude Code, Codex, OpenCode, Hermes, and Pi**.

## Next steps

- [Install](/start-here/install/) — stand up a server and connect your first
  agent, in a few commands.
- [First run](/start-here/first-run/) — what to expect in your first session,
  and how to confirm it is working.

For the marketing pitch — what it is and why you'd want it, at a glance — see the
[project site](https://codeministry.net/the-librarian/).
