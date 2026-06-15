"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { SavePrimerResult } from "@/app/settings/actions";
import { Button } from "@/components/ui-v2/button";
import { SectionLabel } from "@/components/ui-v2/section-label";

// Primer admin field (spec 041 A1, repointed by rethink T11).
//
// The labelled textarea over vault/primer.md — the one ≤2KB document
// delivered when an agent connects (MCP initialize `instructions` + the
// public GET /primer.md). Pre-filled with the file's current content; an
// EMPTY textarea DISABLES the primer. Over-2KB is refused server-side and
// the teaching error renders inline.
//
// The form lives chromeless: it's the only setting on the page, so the
// page is the container — wrapping it in another bordered card would
// nest cards.

export function AwarenessPrimerForm({
  initial,
  onSave,
}: {
  initial: string;
  onSave: (primer: string) => Promise<SavePrimerResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [primer, setPrimer] = useState(initial);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Five-second auto-dismiss matches the archive-view inline toast pattern.
  useEffect(() => {
    if (!saved) return;
    const id = window.setTimeout(() => setSaved(false), 5000);
    return () => window.clearTimeout(id);
  }, [saved]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      setError(null);
      setSaved(false);
      const result = await onSave(primer);
      if (result.ok) {
        setSaved(true);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPrimer(e.target.value);
    // A stale status from a prior save lies once the operator starts editing.
    if (saved) setSaved(false);
    if (error) setError(null);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-5" aria-label="Awareness primer form">
      <header className="flex flex-col gap-1.5">
        <h2 className="font-display text-lg text-foreground">Primer</h2>
        <p id="awareness-primer-hint" className="text-sm leading-relaxed text-foreground/60">
          Stored at <code className="font-mono text-foreground/80">vault/primer.md</code> and
          delivered when an agent connects — via the MCP <code>instructions</code> field and the
          public <code className="font-mono text-foreground/80">/primer.md</code> endpoint —
          teaching every harness the recall / remember loop, handoffs, and private mode. Max 2 KB.
          Leave it empty to disable the primer.
        </p>
      </header>

      <div className="flex flex-col gap-1.5">
        <SectionLabel as="label" htmlFor="awareness-primer">
          Primer text
        </SectionLabel>
        <textarea
          id="awareness-primer"
          aria-label="Awareness primer text"
          aria-describedby="awareness-primer-hint"
          className="min-h-48 border border-ink-hairline bg-ink-mono-fill p-3 font-mono text-xs leading-relaxed text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-accent"
          value={primer}
          onChange={onChange}
        />
      </div>

      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {saved ? (
        <p
          role="status"
          className="border border-ink-accent/40 bg-ink-accent/[0.06] p-3 text-sm text-foreground"
        >
          Saved.
        </p>
      ) : null}

      <Button type="submit" variant="primary" className="self-start" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
