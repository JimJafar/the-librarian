"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui-v2/button";

type RestartOutcome = "started" | "stopped" | "restarted" | "already_in_progress" | "failed";

type RestartAction = () => Promise<
  | { ok: true; outcome: RestartOutcome; runningConfigHash: string | null; reason?: string }
  | { ok: false; error: string }
>;

function formatOutcome(outcome: RestartOutcome, reason?: string): string {
  switch (outcome) {
    case "started":
      return "Classifier worker started.";
    case "stopped":
      return "Classifier worker stopped (config disabled or incomplete).";
    case "restarted":
      return "Classifier worker restarted.";
    case "already_in_progress":
      return "A restart was already in progress — coalesced.";
    case "failed":
      return `Restart failed${reason ? `: ${reason}` : "."}`;
  }
}

export function RestartWorkerButton({ onRestart }: { onRestart: RestartAction }) {
  const [pending, startTransition] = useTransition();
  const [toast, setToast] = useState<{ tone: "ok" | "fail"; text: string } | null>(null);

  function handle(): void {
    startTransition(async () => {
      const result = await onRestart();
      if (!result.ok) {
        setToast({ tone: "fail", text: result.error });
        return;
      }
      const tone = result.outcome === "failed" ? "fail" : "ok";
      setToast({ tone, text: formatOutcome(result.outcome, result.reason) });
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" disabled={pending} onClick={handle}>
        {pending ? "Restarting…" : "Restart classifier worker"}
      </Button>
      {toast ? (
        <p
          role="status"
          className={`text-xs ${toast.tone === "ok" ? "text-muted-foreground" : "text-destructive"}`}
        >
          {toast.text}
        </p>
      ) : null}
    </div>
  );
}
