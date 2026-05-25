"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import type { CreateTokenResult } from "@/app/tokens/actions";

// Mint an agent token. On success the plaintext is revealed ONCE in a callout
// with a copy button — it is not recoverable afterwards, so the copy is the
// user's only chance to capture it.
export function GenerateTokenForm({
  onCreate,
}: {
  onCreate: (input: { agentId: string; label?: string }) => Promise<CreateTokenResult>;
}) {
  const [agentId, setAgentId] = useState("");
  const [label, setLabel] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedId = agentId.trim();
    if (!trimmedId) return;
    const trimmedLabel = label.trim();
    startTransition(async () => {
      setError(null);
      setCopyState("idle");
      const res = await onCreate(
        trimmedLabel ? { agentId: trimmedId, label: trimmedLabel } : { agentId: trimmedId },
      );
      if (res.ok) {
        setRevealed(res.token);
        setAgentId("");
        setLabel("");
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  };

  const copy = async () => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed);
      setCopyState("copied");
    } catch {
      // Clipboard can be blocked (permissions, insecure origin); the token is
      // still visible above for manual selection.
      setCopyState("failed");
    }
  };

  return (
    <section className="rounded-md border bg-card p-4" aria-label="Generate token">
      <h2 className="mb-3 font-semibold">Generate a token</h2>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Agent id</span>
          <input
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            placeholder="claude"
            className="rounded-md border bg-background px-2 py-1.5"
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Label (optional)</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="laptop"
            className="rounded-md border bg-background px-2 py-1.5"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {pending ? "Generating…" : "Generate"}
        </button>
      </form>

      {error ? <p className="mt-3 text-sm text-destructive">Error: {error}</p> : null}

      {revealed ? (
        <div className="mt-4 rounded-md border border-primary/40 bg-primary/5 p-3" role="status">
          <p className="text-sm font-medium">Copy this token now — it won’t be shown again.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-background px-2 py-1 font-mono text-xs">
              {revealed}
            </code>
            <button
              type="button"
              onClick={copy}
              className="rounded-md border px-2 py-1 text-sm hover:bg-muted"
            >
              {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
            </button>
            <button
              type="button"
              onClick={() => setRevealed(null)}
              className="rounded-md border px-2 py-1 text-sm hover:bg-muted"
            >
              Done
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
