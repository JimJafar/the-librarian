"use client";

// Backup config form (automated-backups A6) — editorial rebuild. No card
// chrome (the parent page owns the section container); SectionLabel field
// labels, ui-v2 Input + Button. The GitHub remote stays grouped under its
// own SectionLabel sub-header. Token field is write-only — blank keeps the
// stored secret, never round-trips.

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { BackupCockpitConfig } from "./config-summary";
import type { SaveBackupConfigInput, SaveConfigResult } from "@/app/settings/backups/actions";
import { Button } from "@/components/ui-v2/button";
import { Hairline } from "@/components/ui-v2/hairline";
import { Input } from "@/components/ui-v2/input";
import { SectionLabel } from "@/components/ui-v2/section-label";

export function BackupConfigForm({
  initial,
  onSave,
}: {
  initial: BackupCockpitConfig;
  onSave: (input: SaveBackupConfigInput) => Promise<SaveConfigResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [enabled, setEnabled] = useState(initial.enabled);
  const [intervalMinutes, setIntervalMinutes] = useState(String(initial.intervalMinutes));
  const [webhookUrl, setWebhookUrl] = useState(initial.webhookUrl);
  const [repo, setRepo] = useState(initial.github.repo);
  const [token, setToken] = useState("");

  // Enabling scheduled backups without a configured remote would fail at the
  // next tick — gate the toggle, and if the operator un-configures the repo
  // while enabled, fall the toggle back to off so the saved state can't
  // re-enable an un-configured destination.
  const hasRepo = repo.trim().length > 0;
  const toggleDisabled = !hasRepo && !enabled;
  useEffect(() => {
    if (!hasRepo && enabled) setEnabled(false);
  }, [hasRepo, enabled]);

  useEffect(() => {
    if (!saved) return;
    const id = window.setTimeout(() => setSaved(false), 5000);
    return () => window.clearTimeout(id);
  }, [saved]);

  const clearStatus = () => {
    setSaved(false);
    setError(null);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    clearStatus();
    startTransition(async () => {
      const input: SaveBackupConfigInput = {
        enabled,
        intervalMinutes: Number(intervalMinutes),
        webhookUrl,
        github: { repo },
      };
      if (token) input.github!.token = token;

      const result = await onSave(input);
      if (result.ok) {
        setSaved(true);
        setToken("");
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-5"
      aria-label="Backup configuration form"
      noValidate
    >
      <div className="flex flex-col gap-2">
        <label
          className={`inline-flex items-center gap-2 text-sm text-foreground ${
            toggleDisabled ? "opacity-60" : ""
          }`}
        >
          <input
            type="checkbox"
            checked={enabled}
            disabled={toggleDisabled}
            onChange={(e) => {
              setEnabled(e.target.checked);
              clearStatus();
            }}
            className="h-4 w-4 accent-ink-accent disabled:cursor-not-allowed"
          />
          Enable scheduled backups
        </label>
        {toggleDisabled ? (
          <p className="border border-ink-copper/40 bg-ink-copper/[0.06] p-3 text-sm text-foreground">
            Configure a GitHub repository below before enabling scheduled backups — without a
            destination the next tick would fail.
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <SectionLabel as="label" htmlFor="backup-interval">
            Run every (minutes)
          </SectionLabel>
          <Input
            id="backup-interval"
            type="number"
            min="1"
            className="w-32"
            value={intervalMinutes}
            onChange={(e) => {
              setIntervalMinutes(e.target.value);
              clearStatus();
            }}
          />
          <p className="text-xs text-foreground/60">5 = aggressive · 60 = hourly · 1440 = daily</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <SectionLabel as="label" htmlFor="backup-webhook">
            Failure webhook URL
          </SectionLabel>
          <Input
            id="backup-webhook"
            type="url"
            placeholder="https://hooks.example/backup"
            value={webhookUrl}
            onChange={(e) => {
              setWebhookUrl(e.target.value);
              clearStatus();
            }}
          />
          <p className="text-xs text-foreground/60">
            POST URL — fires once on failure. Blank = off.
          </p>
        </div>
      </div>

      <Hairline />

      <div className="flex flex-col gap-3">
        <header className="flex flex-col gap-1">
          <SectionLabel as="p">GitHub backup remote</SectionLabel>
          <p className="text-xs text-foreground/60">
            A backup <code className="font-mono text-foreground/80">git push</code>es the memory
            vault to this repo. The token is stored encrypted and never shown again.
          </p>
        </header>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <SectionLabel as="label" htmlFor="backup-repo">
              Repository (owner/repo)
            </SectionLabel>
            <Input
              id="backup-repo"
              variant="mono"
              placeholder="me/librarian-vault-backup"
              value={repo}
              onChange={(e) => {
                setRepo(e.target.value);
                clearStatus();
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <SectionLabel as="label" htmlFor="backup-token">
              Fine-grained token — contents: read &amp; write
            </SectionLabel>
            <Input
              id="backup-token"
              type="password"
              variant="mono"
              placeholder={initial.github.hasToken ? "•••••• (configured)" : "not set"}
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                clearStatus();
              }}
            />
            <p className="text-xs text-foreground/60">Blank = keep current.</p>
          </div>
        </div>
      </div>

      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          Error: {error}
        </p>
      ) : null}
      {saved ? (
        <p
          role="status"
          className="border border-ink-accent/40 bg-ink-accent/[0.06] p-3 text-sm text-foreground"
        >
          Saved.
        </p>
      ) : null}

      <Button type="submit" variant="primary" className="self-start" disabled={pending}>
        {pending ? "Saving…" : "Save configuration"}
      </Button>
    </form>
  );
}
