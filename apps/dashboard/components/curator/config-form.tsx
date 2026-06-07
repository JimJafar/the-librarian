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
  const [intervalDays, setIntervalDays] = useState(String(initial.intervalDays));
  const [scheduleTime, setScheduleTime] = useState(initial.scheduleTime);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    // Client-side guard mirrors the core writer's bounds (writeCuratorConfig is the
    // single source of truth; a bad value still round-trips as a server BAD_REQUEST).
    const days = Number(intervalDays);
    if (!Number.isInteger(days) || days < 1) {
      setStatus("Run interval must be a whole number of at least 1 day.");
      return;
    }
    startTransition(async () => {
      const patch: CuratorConfigPatch = {
        enabled,
        defaultAutoApply: level,
        autoApplyConfidence: Number(confidence),
        intervalDays: days,
        scheduleTime,
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
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>Run every</span>
          <input
            className={`${inputClass} w-16`}
            type="number"
            min="1"
            step="1"
            aria-label="Run every (days)"
            value={intervalDays}
            onChange={(e) => setIntervalDays(e.target.value)}
            onInvalid={(e) => {
              // Native constraint (min=1) blocks the submit before the JS guard
              // runs; mirror its inline message so the admin sees why nothing saved.
              e.preventDefault();
              setStatus("Run interval must be a whole number of at least 1 day.");
            }}
          />
          <span>days at</span>
          <input
            className={inputClass}
            type="time"
            aria-label="at (HH:MM)"
            value={scheduleTime}
            onChange={(e) => setScheduleTime(e.target.value)}
          />
        </div>
        <span className="text-xs text-muted-foreground">
          1 = nightly · 7 = weekly · 30 ≈ monthly
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
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
      </div>
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
