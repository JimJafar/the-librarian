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
  const [provider, setProvider] = useState(initial.llm.provider);
  const [endpoint, setEndpoint] = useState(initial.llm.endpoint);
  const [model, setModel] = useState(initial.llm.model);
  const [timeoutMs, setTimeoutMs] = useState(String(initial.llm.timeoutMs));
  const [token, setToken] = useState("");
  const [level, setLevel] = useState<AutoApplyLevel>(initial.defaultAutoApply);
  const [confidence, setConfidence] = useState(String(initial.autoApplyConfidence));
  const [intervalDays, setIntervalDays] = useState(String(initial.schedule.intervalDays));
  const [time, setTime] = useState(initial.schedule.time);
  const [addendum, setAddendum] = useState(initial.promptAddendum);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const patch: CuratorConfigPatch = {
        enabled,
        llm: { provider, endpoint, model, timeoutMs: Number(timeoutMs) },
        defaultAutoApply: level,
        autoApplyConfidence: Number(confidence),
        schedule: { intervalDays: Number(intervalDays), time },
        promptAddendum: addendum,
      };
      // An empty token field leaves the stored token unchanged (never round-tripped).
      if (token.length > 0) patch.token = token;
      const result = await onSave(patch);
      setStatus(result.ok ? "Saved." : `Error: ${result.error}`);
      if (result.ok) {
        setToken("");
        router.refresh();
      }
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
        <Field label="Provider">
          <input
            className={inputClass}
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          />
        </Field>
        <Field label="Endpoint">
          <input
            className={inputClass}
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
        </Field>
        <Field label="Model">
          <input className={inputClass} value={model} onChange={(e) => setModel(e.target.value)} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field label="API token (blank = keep current)">
          <input
            className={inputClass}
            type="password"
            value={token}
            placeholder={initial.hasToken ? "•••••• (configured)" : "not set"}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
        <Field label="LLM request timeout (ms)">
          <input
            className={inputClass}
            type="number"
            min="1000"
            max="600000"
            step="1000"
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(e.target.value)}
          />
        </Field>
      </div>
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
        <Field label="Run time (HH:MM)">
          <input
            className={inputClass}
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Run every N days">
        <input
          className={inputClass}
          type="number"
          min="1"
          value={intervalDays}
          onChange={(e) => setIntervalDays(e.target.value)}
        />
      </Field>
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
