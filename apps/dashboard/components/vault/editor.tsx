"use client";

// Raw markdown editor for a vault file (rethink T19). Saves go through the
// server action → store layer: per-kind frontmatter validation (errors render
// inline, the file is never written invalid) and compare-and-swap on the hash
// captured at load — a file changed underneath comes back as a conflict, never
// a silent overwrite. Primer/.curator files show their 2 KB byte budget live.

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import type { SaveVaultFileResult } from "@/app/vault/actions";
import { Button } from "@/components/ui-v2/button";
import type { VaultFile } from "@/components/vault/types";

const BYTE_CAP = 2048; // the primer/addendum cap (spec §5.2 / 044 §7.1)

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function VaultEditor({
  file,
  onSave,
  onDone,
}: {
  file: VaultFile;
  onSave: (input: {
    path: string;
    raw: string;
    expectedHash: string;
  }) => Promise<SaveVaultFileResult>;
  /** Called after a successful save (the view re-fetches the file). */
  onDone: () => void;
}) {
  const router = useRouter();
  const [raw, setRaw] = useState(file.raw);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const budgeted = file.kind === "primer" || file.kind === "curator";
  const bytes = useMemo(() => (budgeted ? utf8Bytes(raw) : 0), [budgeted, raw]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await onSave({ path: file.path, raw, expectedHash: file.hash });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      router.refresh();
      onDone();
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" aria-label={`Edit ${file.path}`}>
      <textarea
        aria-label="Raw markdown"
        className="min-h-[320px] rounded-md border border-input bg-background p-3 font-mono text-xs"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        spellCheck={false}
      />
      {budgeted ? (
        <p className={`text-xs ${bytes > BYTE_CAP ? "text-destructive" : "text-muted-foreground"}`}>
          {bytes} / {BYTE_CAP} bytes
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
