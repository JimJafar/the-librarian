"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { SavePrimerResult } from "@/app/settings/actions";

// The awareness-primer admin field (spec 041 PR-1 / Task A1). A labelled textarea
// for the server-sourced primer that gets injected on EVERY harness turn (once A2
// wires it into conv_state_get + the plugins render it). The textarea is
// pre-filled with the current primer (the shipped default when never set); an
// EMPTY textarea DISABLES the primer (no block injected anywhere).
export function AwarenessPrimerForm({
  initial,
  onSave,
}: {
  initial: string;
  onSave: (primer: string) => Promise<SavePrimerResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<string | null>(null);
  const [primer, setPrimer] = useState(initial);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await onSave(primer);
      setStatus(result.ok ? "Saved." : `Error: ${result.error}`);
      if (result.ok) router.refresh();
    });
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-md border bg-card p-4"
      aria-label="Awareness primer form"
    >
      <h2 className="font-semibold">Awareness primer</h2>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-muted-foreground" id="awareness-primer-hint">
          This text is injected every turn on every harness, telling the agent it has durable memory
          and which verbs to use. Leave it empty to disable the primer (no block injected anywhere).
        </span>
        <textarea
          aria-label="Awareness primer text"
          aria-describedby="awareness-primer-hint"
          className="min-h-[120px] rounded-md border border-input bg-background p-2 font-mono text-sm"
          value={primer}
          onChange={(e) => setPrimer(e.target.value)}
        />
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
