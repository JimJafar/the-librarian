"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import type { CreateTokenResult } from "@/app/settings/tokens/actions";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";
import { SectionLabel } from "@/components/ui-v2/section-label";

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
    <section className="border border-ink-hairline bg-ink-surface p-4" aria-label="Generate token">
      <h2 className="mb-3 font-display text-lg text-foreground">Generate a token</h2>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5 text-sm">
          <SectionLabel as="span">Agent id</SectionLabel>
          <Input
            variant="mono"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            placeholder="claude"
            required
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <SectionLabel as="span">Label (optional)</SectionLabel>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="laptop" />
        </label>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Generating…" : "Generate"}
        </Button>
      </form>

      {error ? (
        <p
          role="alert"
          className="mt-3 border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          Error: {error}
        </p>
      ) : null}

      {revealed ? (
        <div role="status" className="mt-4 border border-ink-accent/40 bg-ink-accent/[0.06] p-3">
          <p className="text-sm font-medium text-foreground">
            Copy this token now — it won&rsquo;t be shown again.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="flex-1 break-all border border-ink-hairline bg-ink-mono-fill px-2 py-1 font-mono text-xs text-foreground">
              {revealed}
            </code>
            <Button type="button" variant="outline" onClick={copy}>
              {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setRevealed(null)}>
              Done
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
