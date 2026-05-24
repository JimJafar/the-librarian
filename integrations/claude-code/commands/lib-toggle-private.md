---
description: Toggle off-record (private) mode — the Librarian stops recording until you toggle back
---

Flip The Librarian's local **off-record mode** for this harness.

This is a **local** privacy control. It is enforced by the Librarian
`UserPromptSubmit` hook, not by this command file or any MCP/CLI call — typing
`/lib-toggle-private` is detected by the hook synchronously, *before* the prompt
reaches the model, and it:

- flips local mode between **public** and **private**;
- when going **public → private** with a session attached, ends that session
  with a neutral reason (`switching to private mode`) and makes no further
  automatic Librarian calls until you go public again;
- when going **private → public**, resumes normal behaviour from your *next*
  prompt (this prompt is not recorded).

You do not need to call any tool. Just tell the user which way they toggled:
confirm "**now private** — recording paused" or "**now public** — recording
resumed", based on what they asked for. If the lifecycle hook is not installed,
this command is a no-op and you should say so.

The natural-language markers (`off the record`, `don't remember this`, …) are the
primary, unambiguous way to go private; this command is the explicit toggle.

Canonical contract: [`docs/slash-commands.md`](../../../docs/slash-commands.md).
