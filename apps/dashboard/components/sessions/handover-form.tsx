"use client";

import { useState, useTransition } from "react";
import { continueSessionAction } from "@/app/sessions/[id]/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const HARNESSES = ["claude-code", "codex", "opencode", "hermes", "pi"] as const;

export function HandoverForm({ sessionId }: { sessionId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [handover, setHandover] = useState<unknown>(null);
  const [pending, startTransition] = useTransition();
  return (
    <section className="rounded-md border bg-card p-4">
      <h2 className="mb-2 text-lg font-semibold">Continue / handover</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        Build a handover packet for a new agent. Set the target harness to format the payload for
        that runtime.
      </p>
      <form
        action={(form) =>
          startTransition(async () => {
            const result = await continueSessionAction(sessionId, form);
            if (result.ok) {
              setHandover(result.handover);
              setError(null);
            } else {
              setError(result.error);
              setHandover(null);
            }
          })
        }
        className="flex flex-col gap-3 text-sm"
      >
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Target harness</span>
          <select
            name="target_harness"
            className="h-9 rounded-md border border-input bg-background px-2"
            defaultValue=""
          >
            <option value="">(unchanged)</option>
            {HARNESSES.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Target cwd</span>
          <Input name="target_cwd" placeholder="/absolute/path" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Target source ref</span>
          <Input name="target_source_ref" placeholder="claude:session:… / cwd:…" />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="attach" />
          <span>Attach this session to the new caller on success</span>
        </label>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" disabled={pending}>
          {pending ? "Building…" : "Continue session"}
        </Button>
      </form>
      {handover ? (
        <pre className="mt-3 max-h-72 overflow-auto rounded-md bg-muted/40 p-3 text-xs">
          {JSON.stringify(handover, null, 2)}
        </pre>
      ) : null}
    </section>
  );
}
