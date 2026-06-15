"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { BackupCockpitConfig } from "./config-summary";
import type { SaveBackupConfigInput, SaveConfigResult } from "@/app/settings/backups/actions";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

const inputClass = "rounded-md border bg-background px-2 py-1 font-mono text-sm";

export function BackupConfigForm({
  initial,
  onSave,
}: {
  initial: BackupCockpitConfig;
  onSave: (input: SaveBackupConfigInput) => Promise<SaveConfigResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<string | null>(null);

  const [enabled, setEnabled] = useState(initial.enabled);
  const [intervalMinutes, setIntervalMinutes] = useState(String(initial.intervalMinutes));
  const [webhookUrl, setWebhookUrl] = useState(initial.webhookUrl);
  const [repo, setRepo] = useState(initial.github.repo);
  const [token, setToken] = useState("");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const input: SaveBackupConfigInput = {
        enabled,
        intervalMinutes: Number(intervalMinutes),
        webhookUrl,
        github: { repo },
      };
      // The token is write-only — only send it when non-empty; blank keeps the stored value.
      if (token) input.github!.token = token;

      const result = await onSave(input);
      setStatus(result.ok ? "Saved." : `Error: ${result.error}`);
      if (result.ok) {
        setToken("");
        router.refresh();
      }
    });
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-md border bg-card p-4"
      aria-label="Backup configuration form"
    >
      <h2 className="font-semibold">Edit configuration</h2>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enable scheduled backups
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Run every N minutes">
          <input
            className={inputClass}
            type="number"
            min="1"
            value={intervalMinutes}
            onChange={(e) => setIntervalMinutes(e.target.value)}
          />
        </Field>
        <Field label="Failure webhook URL (blank = off)">
          <input
            className={inputClass}
            type="url"
            placeholder="https://hooks.example/backup"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
          />
        </Field>
      </div>

      <fieldset className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
        <legend className="px-1 text-xs text-muted-foreground">GitHub backup remote</legend>
        <Field label="Repository (owner/repo)">
          <input
            className={inputClass}
            placeholder="me/librarian-vault-backup"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          />
        </Field>
        <Field label="Fine-grained token — contents: read & write (blank = keep)">
          <input
            className={inputClass}
            type="password"
            placeholder={initial.github.hasToken ? "•••••• (configured)" : "not set"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
      </fieldset>

      <p className="text-xs text-muted-foreground">
        A backup <code>git push</code>es the memory vault to this repo. The token is stored
        encrypted and never shown again.
      </p>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        {status ? <span className="text-sm text-muted-foreground">{status}</span> : null}
      </div>
    </form>
  );
}
