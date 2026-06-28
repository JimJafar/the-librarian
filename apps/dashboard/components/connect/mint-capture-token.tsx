"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import type { CreateCaptureTokenResult } from "@/app/settings/connect/actions";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";
import { SectionLabel } from "@/components/ui-v2/section-label";

// Mint a CAPTURE-scoped token for a device (D2/D21). On success the plaintext is
// revealed ONCE in a callout with a copy button — it is not recoverable
// afterwards, so the copy is the user's only chance to capture it. The reveal
// reminds the operator to paste it (with the server URL above) into the
// extension options / iOS Shortcut / Android recipe.
export function MintCaptureToken({
  onCreate,
}: {
  onCreate: (input: { label?: string }) => Promise<CreateCaptureTokenResult>;
}) {
  const [label, setLabel] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = label.trim();
    startTransition(async () => {
      setError(null);
      setCopyState("idle");
      const res = await onCreate(trimmed ? { label: trimmed } : {});
      if (res.ok) {
        setRevealed(res.token);
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
      setCopyState("failed");
    }
  };

  return (
    <section
      className="border border-ink-hairline bg-ink-surface p-4"
      aria-label="Mint a capture token"
    >
      <h2 className="mb-1 font-display text-lg text-foreground">Mint a capture token</h2>
      <p className="mb-3 max-w-[60ch] text-sm text-foreground/70">
        A capture token can only file references — it never reaches the agent memory tools. Mint one
        per device, then paste it (with the server URL above) into that client once.
      </p>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5 text-sm">
          <SectionLabel as="span">Device name (optional)</SectionLabel>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="work laptop"
          />
        </label>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Minting…" : "Mint capture token"}
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
          <p className="mt-2 text-xs text-foreground/60">
            Paste it, together with the server URL above, into your browser extension options, the
            iOS Shortcut import prompt, or your Android recipe.
          </p>
        </div>
      ) : null}
    </section>
  );
}
