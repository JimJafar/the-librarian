"use client";

// Classifier configuration form. Provider-mode radio toggles between
// two field groups; the remote group is the standard LLM connection
// surface (provider/endpoint/model/timeoutMs/token), the local group
// is a CATALOG-backed picker plus a collapsible custom-id escape hatch
// for HF identifiers not in the catalog, plus an optional quant input.
//
// Cross-mode state is preserved in component state so flipping the
// radio back and forth doesn't lose what the admin typed. The patch
// posted to `setConfig` only includes the active mode's fields plus
// the mode itself.
//
// The token input is masked (`type=password`) and never pre-filled.
// Submitting an empty token leaves the stored token unchanged; submit
// the literal empty string only when the admin types it explicitly
// (the form sends `token: undefined` when the box is untouched).

import { CATALOG, DEFAULT_MODEL_ID } from "@librarian/classifier";
import type { ClassifierConfig, ClassifierConfigPatch } from "@librarian/core";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui-v2/button";

type SaveAction = (
  patch: ClassifierConfigPatch,
) => Promise<{ ok: true; config: ClassifierConfig } | { ok: false; error: string }>;

interface FormState {
  enabled: boolean;
  providerMode: "remote" | "local";
  // remote
  remoteProvider: string;
  remoteEndpoint: string;
  remoteModel: string;
  remoteTimeoutMs: string;
  remoteToken: string; // never pre-filled; "" means "leave unchanged"
  // local
  localCatalogId: string; // "" means use custom id
  localCustomId: string;
  localQuant: string;
  // shared
  promptVersion: string; // "" means use classifier default (null)
}

function initialFormState(config: ClassifierConfig): FormState {
  // Pre-fill the catalog dropdown when the stored modelId matches a
  // catalog entry; otherwise drop into the custom-id escape hatch so
  // the admin sees the value they had.
  const inCatalog = CATALOG.find((c) => c.id === config.local.modelId);
  return {
    enabled: config.enabled,
    providerMode: config.providerMode,
    remoteProvider: config.llm.provider,
    remoteEndpoint: config.llm.endpoint,
    remoteModel: config.llm.model,
    remoteTimeoutMs: String(config.llm.timeoutMs),
    remoteToken: "",
    localCatalogId: inCatalog ? inCatalog.id : config.local.modelId === "" ? DEFAULT_MODEL_ID : "",
    localCustomId: inCatalog || config.local.modelId === "" ? "" : config.local.modelId,
    localQuant: config.local.quant ?? "",
    promptVersion: config.promptVersion ?? "",
  };
}

export function ClassifierConfigForm({
  config,
  onSave,
}: {
  config: ClassifierConfig;
  onSave: SaveAction;
}) {
  const [state, setState] = useState<FormState>(() => initialFormState(config));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showCustomLocal, setShowCustomLocal] = useState(state.localCatalogId === "");
  const [tokenTouched, setTokenTouched] = useState(false);

  function patch<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setState((s) => ({ ...s, [key]: value }));
  }

  function buildPatch(): ClassifierConfigPatch {
    const out: ClassifierConfigPatch = {
      enabled: state.enabled,
      providerMode: state.providerMode,
    };
    if (state.providerMode === "remote") {
      const timeoutMs = Number.parseInt(state.remoteTimeoutMs, 10);
      out.llm = {
        provider: state.remoteProvider.trim(),
        endpoint: state.remoteEndpoint.trim(),
        model: state.remoteModel.trim(),
        ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
      };
      if (tokenTouched) out.token = state.remoteToken;
    } else {
      const modelId = (showCustomLocal ? state.localCustomId : state.localCatalogId).trim();
      out.local = {
        modelId,
        quant: state.localQuant.trim() === "" ? null : state.localQuant.trim(),
      };
    }
    out.promptVersion = state.promptVersion.trim() === "" ? null : state.promptVersion.trim();
    return out;
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await onSave(buildPatch());
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Clear the password field on success so a future submit doesn't
      // re-send the same plaintext.
      patch("remoteToken", "");
      setTokenTouched(false);
    });
  }

  return (
    <section className="rounded-md border bg-card p-4" aria-label="Classifier configuration form">
      <header className="mb-3">
        <h2 className="font-semibold">Edit configuration</h2>
      </header>
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={state.enabled}
            disabled={pending}
            onChange={(e) => patch("enabled", e.target.checked)}
          />
          Enable classifier worker
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-medium text-muted-foreground">Provider mode</legend>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="providerMode"
                value="remote"
                checked={state.providerMode === "remote"}
                disabled={pending}
                onChange={() => patch("providerMode", "remote")}
              />
              Remote (OpenAI-compatible API)
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="providerMode"
                value="local"
                checked={state.providerMode === "local"}
                disabled={pending}
                onChange={() => patch("providerMode", "local")}
              />
              Local (GGUF model)
            </label>
          </div>
        </fieldset>

        {state.providerMode === "remote" ? (
          <RemoteFields
            state={state}
            disabled={pending}
            onChange={patch}
            tokenTouched={tokenTouched}
            onTokenTouched={setTokenTouched}
          />
        ) : (
          <LocalFields
            state={state}
            disabled={pending}
            onChange={patch}
            showCustom={showCustomLocal}
            onShowCustomToggle={setShowCustomLocal}
          />
        )}

        <FieldRow
          id="classifier-prompt-version"
          label="Prompt version"
          hint="Optional. e.g. v1 / v2. Empty uses the classifier package default."
        >
          <input
            id="classifier-prompt-version"
            type="text"
            inputMode="text"
            disabled={pending}
            value={state.promptVersion}
            onChange={(e) => patch("promptVersion", e.target.value)}
            placeholder="(default)"
            className="rounded-md border bg-background px-2 py-1 text-sm"
          />
        </FieldRow>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </section>
  );
}

function RemoteFields({
  state,
  disabled,
  onChange,
  tokenTouched,
  onTokenTouched,
}: {
  state: FormState;
  disabled: boolean;
  onChange: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  tokenTouched: boolean;
  onTokenTouched: (v: boolean) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <FieldRow id="classifier-remote-provider" label="Provider">
        <input
          id="classifier-remote-provider"
          type="text"
          disabled={disabled}
          value={state.remoteProvider}
          onChange={(e) => onChange("remoteProvider", e.target.value)}
          placeholder="openai / azure / …"
          className="rounded-md border bg-background px-2 py-1 text-sm"
        />
      </FieldRow>
      <FieldRow id="classifier-remote-endpoint" label="Endpoint">
        <input
          id="classifier-remote-endpoint"
          type="url"
          disabled={disabled}
          value={state.remoteEndpoint}
          onChange={(e) => onChange("remoteEndpoint", e.target.value)}
          placeholder="https://api.openai.com/v1"
          className="rounded-md border bg-background px-2 py-1 text-sm"
        />
      </FieldRow>
      <FieldRow id="classifier-remote-model" label="Model">
        <input
          id="classifier-remote-model"
          type="text"
          disabled={disabled}
          value={state.remoteModel}
          onChange={(e) => onChange("remoteModel", e.target.value)}
          placeholder="gpt-4o-mini"
          className="rounded-md border bg-background px-2 py-1 text-sm"
        />
      </FieldRow>
      <FieldRow id="classifier-remote-timeout" label="Timeout (ms)">
        <input
          id="classifier-remote-timeout"
          type="number"
          inputMode="numeric"
          min={1000}
          max={600000}
          disabled={disabled}
          value={state.remoteTimeoutMs}
          onChange={(e) => onChange("remoteTimeoutMs", e.target.value)}
          className="rounded-md border bg-background px-2 py-1 text-sm"
        />
      </FieldRow>
      <FieldRow
        id="classifier-remote-token"
        label="API token"
        hint={
          tokenTouched
            ? "Will replace the stored token on save."
            : "Leave empty to keep the stored token unchanged."
        }
      >
        <input
          id="classifier-remote-token"
          type="password"
          autoComplete="off"
          disabled={disabled}
          value={state.remoteToken}
          onChange={(e) => {
            onChange("remoteToken", e.target.value);
            onTokenTouched(true);
          }}
          placeholder="(unchanged)"
          className="rounded-md border bg-background px-2 py-1 text-sm"
        />
      </FieldRow>
    </div>
  );
}

function LocalFields({
  state,
  disabled,
  onChange,
  showCustom,
  onShowCustomToggle,
}: {
  state: FormState;
  disabled: boolean;
  onChange: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  showCustom: boolean;
  onShowCustomToggle: (v: boolean) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <FieldRow
        id="classifier-local-model"
        label="Local model"
        hint="Picked from the curated catalog by default."
      >
        <select
          id="classifier-local-model"
          disabled={disabled || showCustom}
          value={state.localCatalogId}
          onChange={(e) => onChange("localCatalogId", e.target.value)}
          className="rounded-md border bg-background px-2 py-1 text-sm"
        >
          <option value="">(choose a catalog entry)</option>
          {CATALOG.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label} — {entry.parameters}, {entry.ramGb} GB
            </option>
          ))}
        </select>
      </FieldRow>
      <FieldRow id="classifier-local-quant" label="Quantisation" hint="e.g. Q4_K_M. Optional.">
        <input
          id="classifier-local-quant"
          type="text"
          disabled={disabled}
          value={state.localQuant}
          onChange={(e) => onChange("localQuant", e.target.value)}
          placeholder="Q4_K_M"
          className="rounded-md border bg-background px-2 py-1 text-sm"
        />
      </FieldRow>
      <div className="sm:col-span-2">
        <details
          open={showCustom}
          onToggle={(e) => onShowCustomToggle((e.target as HTMLDetailsElement).open)}
        >
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Use a custom model identifier
          </summary>
          <div className="mt-2">
            <FieldRow
              id="classifier-local-custom-id"
              label="Custom model id"
              hint="HuggingFace identifier or local path; overrides the catalog pick."
            >
              <input
                id="classifier-local-custom-id"
                type="text"
                disabled={disabled || !showCustom}
                value={state.localCustomId}
                onChange={(e) => onChange("localCustomId", e.target.value)}
                placeholder="org/model-gguf"
                className="rounded-md border bg-background px-2 py-1 text-sm"
              />
            </FieldRow>
          </div>
        </details>
      </div>
    </div>
  );
}

function FieldRow({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}
