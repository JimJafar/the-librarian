---
title: First run
description: What to expect in your first session — and how to confirm The Librarian is working.
---

Once your server is running and a harness is connected, there is nothing else to
turn on. The Librarian works quietly in the background of your normal sessions.
This page walks through what happens, so you know it is working.

## Your agent gets a briefing

At the start of each session, your AI tool loads a short document called the
**primer** from your server. The primer teaches the agent the handful of things
it needs to know: to *recall* relevant memories before answering, to *remember*
durable facts, how to package up a *handoff*, and how to go *private*. You do not
have to prompt any of this — it is delivered automatically when the agent
connects.

## It remembers as you work

You can save things to memory in two ways:

- **Just say so.** Tell the agent "remember that we deploy on Fridays" and it
  calls the `remember` action for you. You can also ask "what do we know
  about X?" to make it *recall*.
- **Automatically.** On supported tools, The Librarian quietly watches the
  conversation and extracts durable lessons on its own — with the agent making
  no memory calls at all. The capture **hook** ships enabled (you can turn it off
  per machine), but nothing is actually filed until you switch on the curator's
  **Intake** in the dashboard (**Settings → Curator**): it is **off by default**,
  and until it is on the server files nothing it captures. Capture never sends
  anything while you are in [private mode](/guides/private-mode/).

Saved memories do not appear in your collection instantly. Each one goes into the
curator's **intake** queue first, where it is de-duplicated, merged with what you
already know, and filed — usually within moments.

## You stay in control through the dashboard

Open the **dashboard** in a browser (the address `server up` printed, usually
`http://your-host:3042`). This is your cockpit. Some changes the curator makes are
applied automatically; the riskier ones — anything that would archive or
restructure a memory — are held back as **proposals** for you to approve or
reject. Reviewing that queue is the main everyday task, and it is walked through
in [Reviewing & accepting proposals](/guides/reviewing-proposals/).

## A five-minute end-to-end check

First, switch on **Intake** under **Settings → Curator** if you have not already —
it ships **off**, and until it is on the curator never processes your saves and
automatic capture files nothing.

To prove the whole loop works:

1. In your connected tool, say: *"Remember that our staging database resets every
   night at 2am."*
2. Open the dashboard and go to **Memories**. Within a moment you should see the
   new memory appear (it may arrive via the **Proposals** queue first if the
   curator wants your sign-off).
3. Start a fresh session in the **same or a different** connected tool and ask:
   *"When does staging reset?"* The agent should recall the fact you just saved —
   even in a different tool. That cross-tool recall is the whole point.

## If something looks wrong

The Librarian is built to **fail quietly**: if the server is unreachable, your
agent is told to carry on without memory rather than block your work. So a missing
recall usually means the server is down or the token is wrong, never that your
turn is stuck.

- The seven tools do not appear in your harness → re-check the MCP URL and agent
  token; see your tool's [Connect](/connect/claude-code/) page.
- Memories never reach the dashboard → confirm the curator's **intake** is enabled
  under **Settings → Curator**.

## Next steps

- [Using the dashboard](/dashboard/) — a guided tour of every area.
- [Reviewing & accepting proposals](/guides/reviewing-proposals/) — the core
  everyday task.
- [Handoff & takeover](/guides/handoff-takeover/) — move work between tools.
