"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui-v2/button";

type SelfTestOutcome = "ok" | "fallback" | "error";

type SelfTestAction = () => Promise<
  | {
      ok: true;
      outcome: SelfTestOutcome;
      latencyMs: number;
      verdict?: { requires_approval: boolean; is_global: boolean };
      fallbackReason?: string;
      error?: string;
      rawOutput?: string;
    }
  | { ok: false; error: string }
>;

interface ResultRow {
  outcome: SelfTestOutcome | "transport_error";
  latencyMs?: number;
  verdict?: { requires_approval: boolean; is_global: boolean };
  fallbackReason?: string;
  error?: string;
  rawOutput?: string;
}

export function SelfTestButton({ onRun }: { onRun: SelfTestAction }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ResultRow | null>(null);

  function handle(): void {
    startTransition(async () => {
      const res = await onRun();
      if (!res.ok) {
        setResult({ outcome: "transport_error", error: res.error });
        return;
      }
      setResult({
        outcome: res.outcome,
        latencyMs: res.latencyMs,
        ...(res.verdict !== undefined ? { verdict: res.verdict } : {}),
        ...(res.fallbackReason !== undefined ? { fallbackReason: res.fallbackReason } : {}),
        ...(res.error !== undefined ? { error: res.error } : {}),
        ...(res.rawOutput !== undefined ? { rawOutput: res.rawOutput } : {}),
      });
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        disabled={pending}
        onClick={handle}
        title="Builds a transient classifier and runs the self-test fixture against the configured endpoint."
      >
        {pending ? "Testing…" : "Test classifier"}
      </Button>
      {result ? <SelfTestPanel result={result} /> : null}
    </div>
  );
}

function SelfTestPanel({ result }: { result: ResultRow }) {
  if (result.outcome === "transport_error") {
    return (
      <p role="status" className="text-xs text-destructive">
        Self-test request failed: {result.error}
      </p>
    );
  }
  if (result.outcome === "error") {
    return (
      <p role="status" className="text-xs text-destructive">
        {result.error ?? "self-test errored"}
      </p>
    );
  }
  return (
    <div className="rounded-md border bg-card p-2 text-xs">
      <div>
        <span className="font-medium">Outcome:</span> {result.outcome}
      </div>
      {result.latencyMs !== undefined ? (
        <div>
          <span className="font-medium">Latency:</span> {result.latencyMs} ms
        </div>
      ) : null}
      {result.verdict ? (
        <div>
          <span className="font-medium">Verdict:</span> requires_approval=
          {String(result.verdict.requires_approval)}, is_global=
          {String(result.verdict.is_global)}
        </div>
      ) : null}
      {result.fallbackReason ? (
        <div>
          <span className="font-medium">Fallback reason:</span> {result.fallbackReason}
        </div>
      ) : null}
    </div>
  );
}
