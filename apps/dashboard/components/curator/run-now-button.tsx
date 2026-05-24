"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { RunNowResult } from "@/app/curator/actions";

export function RunNowButton({ onRun }: { onRun: () => Promise<RunNowResult> }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();

  const run = () =>
    startTransition(async () => {
      const res = await onRun();
      if (!res.ok) {
        setMessage(`Error: ${res.error}`);
        return;
      }
      const r = res.result;
      setMessage(
        r.ran
          ? `Ran — ${r.summary.ran} of ${r.summary.due} due slice(s) curated.`
          : `Skipped — ${r.reason.replace(/_/g, " ")}.`,
      );
      router.refresh();
    });

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="rounded-md border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {pending ? "Running…" : "Run now"}
      </button>
      {message ? <span className="text-sm text-muted-foreground">{message}</span> : null}
    </div>
  );
}
