"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { BackupCockpitConfig } from "./config-summary";
import type { SaveBackupConfigInput, SaveConfigResult } from "@/app/backups/actions";

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
  const [target, setTarget] = useState(initial.target);
  const [intervalMinutes, setIntervalMinutes] = useState(String(initial.intervalMinutes));
  const [retentionKeep, setRetentionKeep] = useState(String(initial.retentionKeep));
  const [webhookUrl, setWebhookUrl] = useState(initial.webhookUrl);

  const [bucket, setBucket] = useState(initial.s3.bucket);
  const [region, setRegion] = useState(initial.s3.region);
  const [endpoint, setEndpoint] = useState(initial.s3.endpoint);
  const [prefix, setPrefix] = useState(initial.s3.prefix);
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");

  const [repo, setRepo] = useState(initial.github.repo);
  const [token, setToken] = useState("");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const input: SaveBackupConfigInput = {
        enabled,
        target,
        intervalMinutes: Number(intervalMinutes),
        retentionKeep: Number(retentionKeep),
        webhookUrl,
        s3: { bucket, region, endpoint, prefix },
        github: { repo },
      };
      // Secrets are write-only — only send a non-empty field; blank keeps the stored value.
      if (accessKey) input.s3!.accessKey = accessKey;
      if (secretKey) input.s3!.secretKey = secretKey;
      if (token) input.github!.token = token;

      const result = await onSave(input);
      setStatus(result.ok ? "Saved." : `Error: ${result.error}`);
      if (result.ok) {
        setAccessKey("");
        setSecretKey("");
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

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Cloud target">
          <select
            className={inputClass}
            value={target}
            onChange={(e) => setTarget(e.target.value as BackupCockpitConfig["target"])}
          >
            <option value="local">local only</option>
            <option value="s3">S3-compatible</option>
            <option value="github">GitHub Releases</option>
          </select>
        </Field>
        <Field label="Run every N minutes">
          <input
            className={inputClass}
            type="number"
            min="1"
            value={intervalMinutes}
            onChange={(e) => setIntervalMinutes(e.target.value)}
          />
        </Field>
        <Field label="Keep N bundles">
          <input
            className={inputClass}
            type="number"
            min="1"
            value={retentionKeep}
            onChange={(e) => setRetentionKeep(e.target.value)}
          />
        </Field>
      </div>

      <Field label="Failure webhook URL (blank = off)">
        <input
          className={inputClass}
          type="url"
          placeholder="https://hooks.example/backup"
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
        />
      </Field>

      {target === "s3" ? (
        <fieldset className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
          <legend className="px-1 text-xs text-muted-foreground">S3-compatible storage</legend>
          <Field label="Bucket">
            <input
              className={inputClass}
              value={bucket}
              onChange={(e) => setBucket(e.target.value)}
            />
          </Field>
          <Field label="Region">
            <input
              className={inputClass}
              value={region}
              onChange={(e) => setRegion(e.target.value)}
            />
          </Field>
          <Field label="Endpoint (R2/MinIO/Backblaze)">
            <input
              className={inputClass}
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
            />
          </Field>
          <Field label="Prefix">
            <input
              className={inputClass}
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
            />
          </Field>
          <Field label="Access key (blank = keep)">
            <input
              className={inputClass}
              type="password"
              placeholder={initial.s3.hasAccessKey ? "•••••• (configured)" : "not set"}
              value={accessKey}
              onChange={(e) => setAccessKey(e.target.value)}
            />
          </Field>
          <Field label="Secret key (blank = keep)">
            <input
              className={inputClass}
              type="password"
              placeholder={initial.s3.hasSecretKey ? "•••••• (configured)" : "not set"}
              value={secretKey}
              onChange={(e) => setSecretKey(e.target.value)}
            />
          </Field>
        </fieldset>
      ) : null}

      {target === "github" ? (
        <fieldset className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
          <legend className="px-1 text-xs text-muted-foreground">GitHub Releases</legend>
          <Field label="Repository (owner/repo)">
            <input
              className={inputClass}
              placeholder="me/librarian-backups"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
            />
          </Field>
          <Field label="Fine-grained token (blank = keep)">
            <input
              className={inputClass}
              type="password"
              placeholder={initial.github.hasToken ? "•••••• (configured)" : "not set"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </Field>
        </fieldset>
      ) : null}

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
