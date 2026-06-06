"use client";

// Intake enablement toggle (spec 043 C5b). Intake has no grooming-specific knobs
// (auto-apply level / confidence / schedule live on grooming) — its only job-level
// setting here is on/off (`curator.intake.enabled`). Provider/model is the shared
// per-consumer selector. Mirrors the grooming config form's save UX.

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { SaveConfigResult } from "@/app/curator/actions";

export function IntakeConfigForm({
  enabled: initialEnabled,
  onSave,
}: {
  enabled: boolean;
  onSave: (input: { enabled: boolean }) => Promise<SaveConfigResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(initialEnabled);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await onSave({ enabled });
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
      <h3 className="font-semibold">Enablement</h3>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enable inbox consolidation (intake)
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
