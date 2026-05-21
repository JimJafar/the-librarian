"use client";

import { useState, useTransition } from "react";
import { continueSessionAction } from "@/app/sessions/[id]/actions";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";

const HARNESSES = ["claude-code", "codex", "opencode", "hermes", "pi"] as const;
const FORMATS = ["prose", "markdown", "claude", "codex", "opencode", "hermes", "pi"] as const;

interface HandoverPayload {
  text?: string;
  format?: string;
  handover?: unknown;
}

export function HandoverForm({ sessionId }: { sessionId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<HandoverPayload | null>(null);
  const [showRaw, setShowRaw] = useState(false);
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
              setPayload(result.handover as HandoverPayload);
              setError(null);
              setShowRaw(false);
            } else {
              setError(result.error);
              setPayload(null);
            }
          })
        }
        className="flex flex-col gap-3 text-sm"
      >
        <div className="grid grid-cols-2 gap-3">
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
            <span className="text-muted-foreground">Format</span>
            <select
              name="format"
              defaultValue="prose"
              className="h-9 rounded-md border border-input bg-background px-2"
            >
              {FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
        </div>
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
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Building…" : "Continue session"}
        </Button>
      </form>
      {payload?.text ? (
        <div className="mt-3 flex flex-col gap-2">
          <pre className="max-h-72 overflow-auto rounded-md bg-muted/40 p-3 text-xs whitespace-pre-wrap">
            {payload.text}
          </pre>
          <button
            type="button"
            className="self-start text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowRaw((v) => !v)}
          >
            {showRaw ? "Hide" : "Show"} raw handover JSON
          </button>
          {showRaw ? (
            <pre className="max-h-72 overflow-auto rounded-md bg-muted/40 p-3 text-xs">
              {JSON.stringify(payload.handover, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
