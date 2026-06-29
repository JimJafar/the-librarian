---
title: Activity
description: The vault's full change history — who changed what, when — with a whole-vault restore.
---

Every change to The Librarian — by an agent, the curator, or you — is recorded as a
commit in the vault's Git history. The **Activity** page shows that history as a
readable feed, so it doubles as your audit trail and your undo button of last
resort.

![The Activity log](../../../assets/screenshots/activity.png)

## What you'll see

A feed of changes, newest first. Each entry shows a short description of the change,
who or what made it (an agent, the curator, an admin, or the system), and when.
Expand an entry to load the per-file differences for that change, each tagged as
added, modified, deleted, or renamed.

## The main task

Most of the time you are just reading — confirming the curator did what you
expected, or seeing what an agent wrote.

When you need it, each entry also has a **Restore vault to here** button that rolls
the *entire* vault back to that point. Because this is a sweeping, destructive
change, it asks you to type a confirmation phrase before it proceeds. For everyday
"undo one file" you usually want the [Vault](/dashboard/vault/) page's per-file
history instead; this whole-vault restore is for recovering from a bad batch.

If the vault has no commits yet, the page reads **No vault commits yet**.
