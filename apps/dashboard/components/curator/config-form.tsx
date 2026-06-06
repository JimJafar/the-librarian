"use client";

import type { AutoApplyLevel, CuratorConfig, CuratorConfigPatch } from "@librarian/core";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { SaveConfigResult } from "@/app/curator/actions";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

const inputClass = "rounded-md border bg-background px-2 py-1 font-mono text-sm";

export function CuratorConfigForm({
  initial,
  onSave,
}: {
  initial: CuratorConfig;
  onSave: (patch: CuratorConfigPatch) => Promise<SaveConfigResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<string | null>(null);

  const [enabled, setEnabled] = useState(initial.enabled);
  const [level, setLevel] = useState<AutoApplyLevel>(initial.defaultAutoApply);
  const [confidence, setConfidence] = useState(String(initial.autoApplyConfidence));
  const [intervalMinutes, setIntervalMinutes] = useState(String(initial.intervalMinutes));
  const [addendum, setAddendum] = useState(initial.promptAddendum);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const patch: CuratorConfigPatch = {
        enabled,
        defaultAutoApply: level,
        autoApplyConfidence: Number(confidence),
        intervalMinutes: Number(intervalMinutes),
        promptAddendum: addendum,
      };
      const result = await onSave(patch);
      setStatus(result.ok ? "Saved." : `Error: ${result.error}`);
      if (result.ok) router.refresh();
    });
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-md border bg-card p-4"
      aria-label="Curator configuration form"
    >
      <h2 className="font-semibold">Edit configuration</h2>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enable scheduled curation
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Auto-apply">
          <select
            className={inputClass}
            value={level}
            onChange={(e) => setLevel(e.target.value as AutoApplyLevel)}
          >
            <option value="off">off</option>
            <option value="safe_only">safe_only</option>
            <option value="high_confidence">high_confidence</option>
          </select>
        </Field>
        <Field label="Confidence (0–1)">
          <input
            className={inputClass}
            type="number"
            min="0"
            max="1"
            step="0.05"
            value={confidence}
            onChange={(e) => setConfidence(e.target.value)}
          />
        </Field>
        <Field label="Run every N minutes">
          <input
            className={inputClass}
            type="number"
            min="1"
            max={String(7 * 24 * 60)}
            value={intervalMinutes}
            onChange={(e) => setIntervalMinutes(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Prompt addendum (advisory, ≤ 2 KB)">
        <textarea
          className={inputClass}
          rows={3}
          value={addendum}
          onChange={(e) => setAddendum(e.target.value)}
        />
      </Field>
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
