"use client";

// Per-consumer (intake / grooming) provider + model selector (spec 042 §4, B4b).
// A provider dropdown plus a model field. The model field is a dropdown populated
// from `listModels` for the selected provider WITH a free-text fallback: when the
// probe returns [] (unreachable / no token / non-listing endpoint) the user can
// still type a model name, so the picker never blocks configuration.

import type { ConsumerConfig, CuratorConsumer, LlmProvider } from "@librarian/core";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { ConsumerConfigResult, ModelsResult } from "@/app/curator/actions";
import { Select } from "@/components/ui-v2/select";

const inputClass = "rounded-md border bg-background px-2 py-1 font-mono text-sm";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

const CONSUMER_LABEL: Record<CuratorConsumer, string> = {
  intake: "Intake",
  grooming: "Grooming",
};

export function ConsumerModelSelector({
  consumer,
  config,
  providers,
  onSave,
  onListModels,
}: {
  consumer: CuratorConsumer;
  config: ConsumerConfig;
  providers: LlmProvider[];
  onSave: (
    consumer: CuratorConsumer,
    patch: { providerId?: string; model?: string },
  ) => Promise<ConsumerConfigResult>;
  onListModels: (input: { providerId: string }) => Promise<ModelsResult>;
}) {
  const router = useRouter();
  const [providerId, setProviderId] = useState(config.providerId);
  const [model, setModel] = useState(config.model);
  const [models, setModels] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<string | null>(null);

  // Populate the model dropdown whenever a provider is selected. Fail-soft: [] on
  // any error leaves only the free-text input, never blocking the form.
  useEffect(() => {
    let cancelled = false;
    if (!providerId) {
      setModels([]);
      return;
    }
    void onListModels({ providerId }).then((result) => {
      if (!cancelled) setModels(result.models);
    });
    return () => {
      cancelled = true;
    };
  }, [providerId, onListModels]);

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await onSave(consumer, { providerId, model });
      setStatus(result.ok ? "Saved." : `Error: ${result.error}`);
      if (result.ok) router.refresh();
    });
  };

  // The current model isn't always in the listed set (free-text or a stale list);
  // surface it as an extra option so the dropdown round-trips it.
  const options = model && !models.includes(model) ? [model, ...models] : models;
  const listId = `models-${consumer}`;

  return (
    <form
      onSubmit={save}
      className="flex flex-col gap-3 rounded-md border bg-background p-3"
      aria-label={`${CONSUMER_LABEL[consumer]} model selection`}
    >
      <h3 className="text-sm font-medium">{CONSUMER_LABEL[consumer]}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Provider">
          <Select
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            aria-label={`${consumer} provider`}
          >
            <option value="">— none —</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Model (pick or type)">
          {/* A datalist gives a dropdown of probed models while still accepting
              free text — the listModels fallback the spec requires. */}
          <input
            className={inputClass}
            list={listId}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4o-mini"
            aria-label={`${consumer} model`}
          />
          <datalist id={listId}>
            {options.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        {status ? <span className="text-sm text-muted-foreground">{status}</span> : null}
        {!config.providerExists && config.providerId ? (
          <span className="text-sm text-amber-600">Referenced provider was deleted.</span>
        ) : null}
      </div>
    </form>
  );
}
