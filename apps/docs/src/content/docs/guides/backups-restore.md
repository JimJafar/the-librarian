---
title: Backups & restore
description: Keep a safe copy of your vault, and bring it back if you need to.
---

Your memories are too valuable to lose, and because they are just files in a Git
repository, backing them up is wonderfully simple: a backup is a **push** of the
vault to a private remote, and a restore is a **pull** of it back. There are no
special snapshot formats to learn.

## What gets backed up

**The vault is the backed-up thing** — every memory, handoff, and reference, with
its full history. Because every change is already a Git commit, the backup is just
that repository pushed to a private GitHub repo you own.

Two things are deliberately **left out** of a backup:

- **The master key.** Restoring needs you to supply it again — that is the point;
  keeping the key out of the backup means a leaked backup cannot be decrypted. Keep
  the key (shown once when you first ran the server) somewhere safe and separate.
- **The settings file**, which holds your encrypted credentials, lives beside the
  vault rather than in it. If you want settings back without re-entering them,
  include a volume snapshot (below) as well.

## Setting up automatic backups

Open **[Settings → Backups](/dashboard/settings/#backups)** in the dashboard. There
you can:

1. **Choose a target** — a private GitHub repository (`owner/repo`) and a
   fine-grained personal access token with read/write access to it. The token is
   encrypted at rest and never leaves the server or appears in a URL.
2. **Set a schedule** — turn on scheduled backups and choose how often (in
   minutes); the server pushes the vault whenever the interval elapses.
3. **Back up on demand** — press **Backup now** any time.

The page shows the last successful backup and a banner if the most recent one
failed; you can also set a webhook so a failure pings you elsewhere.

## Restoring

A restore clones your backup remote into a fresh data location, replacing the
current vault. You will need to supply the **master key** again, because it was kept
out of the backup. The dashboard's Backups page guides a restore (it safely sets the
current vault aside first); the same thing can be done from the server's command
line, which is covered — along with the exact commands — in
[Authentication & secrets](/deploy-and-operate/auth-and-secrets/) and
[Self-host](/deploy-and-operate/self-host/).

## An alternative: volume snapshots

If you would rather use your own backup tooling, you can snapshot the whole data
volume (a plain compressed tarball, or your cloud platform's volume snapshots). This
captures the settings file too, so it is a good complement to the Git-based vault
backup.

## If a recall index ever looks wrong

The search index agents use is rebuilt automatically from the vault, so there is
nothing in it to back up or repair. If you ever edit the vault files directly,
outside the dashboard, you can force a rebuild from the server command line — but in
normal use you never need to.
