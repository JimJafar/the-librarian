"use client";

// Intake job-level config (spec 043 C5b + spec 045 D-3). Two knobs: the enablement
// toggle (`curator.intake.enabled`) and the sweep cadence — "Run every [N] minutes"
// (`curator.intake.interval_minutes`). Provider/model is the shared per-consumer
// selector, not here. The cadence is validated client-side (integer ≥ 1); the core
// `writeIntakeInterval` is the single source of truth and its teaching error
// surfaces inline as a server BAD_REQUEST. Mirrors the grooming config form's UX.

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { SaveConfigResult } from "@/app/curator/actions";

const inputClass = "rounded-md border bg-background px-2 py-1 font-mono text-sm";

export function IntakeConfigForm({
  enabled: initialEnabled,
  intervalMinutes: initialIntervalMinutes,
  onSave,
}: {
  enabled: boolean;
  intervalMinutes: number;
  onSave: (input: { enabled?: boolean; intervalMinutes?: number }) => Promise<SaveConfigResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [intervalMinutes, setIntervalMinutes] = useState(String(initialIntervalMinutes));

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const minutes = Number(intervalMinutes);
    if (!Number.isInteger(minutes) || minutes < 1) {
      setStatus("Run interval must be a whole number of at least 1 minute.");
      return;
    }
    startTransition(async () => {
      const result = await onSave({ enabled, intervalMinutes: minutes });
      setStatus(result.ok ? "Saved." : `Error: ${result.error}`);
      if (result.ok) router.refresh();
    });
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-md border bg-card p-4"
      aria-label="Intake configuration form"
    >
      <h3 className="font-semibold">Enablement &amp; schedule</h3>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enable inbox consolidation (intake)
      </label>
      <label className="flex items-center gap-2 text-sm">
        <span>Run every</span>
        <input
          className={`${inputClass} w-16`}
          type="number"
          min="1"
          step="1"
          aria-label="Run every (minutes)"
          value={intervalMinutes}
          onChange={(e) => setIntervalMinutes(e.target.value)}
          onInvalid={(e) => {
            // Native constraint (min=1) blocks the submit before the JS guard runs;
            // mirror its inline message so the admin sees *why* nothing saved.
            e.preventDefault();
            setStatus("Run interval must be a whole number of at least 1 minute.");
          }}
        />
        <span>minutes</span>
      </label>
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
