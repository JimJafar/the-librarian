"use client";

// Named LLM provider manager (spec 042 §4, B4b). List / add / edit / delete
// providers. The token field is WRITE-ONLY and masked exactly like the curator
// config-form's: an empty field leaves the stored token unchanged (the secret is
// never round-tripped to the browser — reads expose `hasToken` only). A "Test"
// button probes the endpoint without ever revealing the token.

import type { LlmProvider } from "@librarian/core";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ProviderListResult, TestConnectionResult } from "@/app/curator/actions";

const inputClass = "rounded-md border bg-background px-2 py-1 font-mono text-sm";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export interface ProviderManagerActions {
  onAdd: (input: { name: string; endpoint: string; token?: string }) => Promise<ProviderListResult>;
  onUpdate: (input: {
    id: string;
    name?: string;
    endpoint?: string;
    token?: string;
  }) => Promise<ProviderListResult>;
  onDelete: (id: string) => Promise<ProviderListResult>;
  onTest: (input: {
    providerId?: string;
    endpoint?: string;
    token?: string;
  }) => Promise<TestConnectionResult>;
}

export function ProviderManager({
  initialProviders,
  actions,
}: {
  initialProviders: LlmProvider[];
  actions: ProviderManagerActions;
}) {
  const router = useRouter();
  const [providers, setProviders] = useState<LlmProvider[]>(initialProviders);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const apply = (result: ProviderListResult) => {
    if (result.ok) {
      setProviders(result.providers);
      setEditingId(null);
      setAdding(false);
      router.refresh();
    }
    return result;
  };

  return (
    <section
      className="flex flex-col gap-4 rounded-md border bg-card p-4"
      aria-label="LLM providers"
    >
      <header className="flex items-center justify-between">
        <h2 className="font-semibold">LLM providers</h2>
        {!adding ? (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setEditingId(null);
            }}
            className="rounded-md border px-3 py-1.5 text-sm font-medium"
          >
            Add provider
          </button>
        ) : null}
      </header>

      {providers.length === 0 && !adding ? (
        <p className="text-sm text-muted-foreground">
          No providers yet. Add one to configure intake and grooming models.
        </p>
      ) : null}

      <ul className="flex flex-col gap-2">
        {providers.map((provider) =>
          editingId === provider.id ? (
            <li key={provider.id}>
              <ProviderForm
                initial={provider}
                submitLabel="Save"
                onSubmit={async (input) =>
                  apply(await actions.onUpdate({ id: provider.id, ...input }))
                }
                onCancel={() => setEditingId(null)}
                onTest={actions.onTest}
              />
            </li>
          ) : (
            <li
              key={provider.id}
              className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{provider.name}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {provider.endpoint}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-xs">
                <span className={provider.hasToken ? "text-green-600" : "text-amber-600"}>
                  {provider.hasToken ? "token set" : "no token"}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(provider.id);
                    setAdding(false);
                  }}
                  className="rounded-md border px-2 py-1"
                >
                  Edit
                </button>
                <DeleteButton onDelete={async () => apply(await actions.onDelete(provider.id))} />
              </div>
            </li>
          ),
        )}
      </ul>

      {adding ? (
        <ProviderForm
          submitLabel="Add"
          onSubmit={async (input) => apply(await actions.onAdd(input))}
          onCancel={() => setAdding(false)}
          onTest={actions.onTest}
        />
      ) : null}
    </section>
  );
}

// Add/edit form. On edit, `initial` seeds name+endpoint; the token field is left
// empty (placeholder reflects whether one is configured) and only sent when the
// user types a new value — so the secret is never round-tripped.
function ProviderForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  onTest,
}: {
  initial?: LlmProvider;
  submitLabel: string;
  onSubmit: (input: {
    name: string;
    endpoint: string;
    token?: string;
  }) => Promise<ProviderListResult>;
  onCancel: () => void;
  onTest: ProviderManagerActions["onTest"];
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [endpoint, setEndpoint] = useState(initial?.endpoint ?? "");
  const [token, setToken] = useState("");
  const [pending, startTransition] = useTransition();
  const [testing, startTest] = useTransition();
  const [status, setStatus] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const input: { name: string; endpoint: string; token?: string } = { name, endpoint };
      // An empty token field leaves the stored token unchanged (never round-tripped).
      if (token.length > 0) input.token = token;
      const result = await onSubmit(input);
      if (!result.ok) setStatus(`Error: ${result.error}`);
    });
  };

  // Test the draft as typed (inline endpoint+token) when editing/creating, or the
  // saved provider when no new token was entered.
  const test = () =>
    startTest(async () => {
      setStatus("Testing…");
      const probe =
        initial && token.length === 0
          ? { providerId: initial.id }
          : { endpoint, ...(token ? { token } : {}) };
      const result = await onTest(probe);
      setStatus(
        result.ok ? "Connection OK." : `Connection failed: ${result.error ?? "unreachable"}`,
      );
    });

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-md border bg-background p-3"
      aria-label={initial ? `Edit provider ${initial.name}` : "Add provider"}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="OpenAI"
            required
          />
        </Field>
        <Field label="Endpoint">
          <input
            className={inputClass}
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://api.openai.com/v1"
            required
          />
        </Field>
      </div>
      <Field label="API token (blank = keep current)">
        <input
          className={inputClass}
          type="password"
          value={token}
          placeholder={initial?.hasToken ? "•••••• (configured)" : "not set"}
          onChange={(e) => setToken(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {pending ? "Saving…" : submitLabel}
        </button>
        <button
          type="button"
          onClick={test}
          disabled={testing || endpoint.length === 0}
          className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          {testing ? "Testing…" : "Test connection"}
        </button>
        <button type="button" onClick={onCancel} className="text-sm text-muted-foreground">
          Cancel
        </button>
        {status ? <span className="text-sm text-muted-foreground">{status}</span> : null}
      </div>
    </form>
  );
}

function DeleteButton({ onDelete }: { onDelete: () => Promise<ProviderListResult> }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      onClick={() => startTransition(() => void onDelete())}
      disabled={pending}
      className="rounded-md border px-2 py-1 text-destructive disabled:opacity-50"
    >
      {pending ? "Deleting…" : "Delete"}
    </button>
  );
}
