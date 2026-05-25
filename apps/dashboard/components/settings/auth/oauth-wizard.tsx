"use client";

import { type FormEvent, useState } from "react";
import type { AuthActionResult } from "@/app/settings/auth/actions";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";

const LABEL: Record<"github" | "google", string> = { github: "GitHub", google: "Google" };

// D5.4: configure one OAuth provider. Shows the exact callback URL to register with
// the provider, takes the client id/secret + the allowlisted owner account id, and
// saves both (creds + owner). The secret is never rendered back — only ever sent.
export function OAuthWizard({
  provider,
  callbackUrl,
  ownerId: currentOwnerId,
  configured,
  onSave,
}: {
  provider: "github" | "google";
  callbackUrl: string;
  ownerId: string | null;
  configured: boolean;
  onSave: (input: {
    clientId: string;
    clientSecret: string;
    ownerId: string;
  }) => Promise<AuthActionResult>;
}) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [ownerId, setOwnerId] = useState(currentOwnerId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setBusy(true);
    const result = await onSave({
      clientId: clientId.trim(),
      clientSecret,
      ownerId: ownerId.trim(),
    });
    setBusy(false);
    if (result.ok) {
      setSaved(true);
      setClientSecret("");
    } else {
      setError(result.error);
    }
  }

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
      aria-label={`${LABEL[provider]} OAuth`}
    >
      <h2 className="font-medium text-foreground">{LABEL[provider]} OAuth</h2>
      <div className="flex flex-col gap-1">
        <span className="text-sm text-foreground/60">
          Register this callback URL with {LABEL[provider]}:
        </span>
        <code className="break-all rounded bg-muted/40 px-2 py-1 text-xs text-foreground">
          {callbackUrl}
        </code>
      </div>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Input
          type="text"
          placeholder="Client ID"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          autoComplete="off"
          required
        />
        <Input
          type="password"
          placeholder={
            configured ? "Client secret (leave set; re-enter to change)" : "Client secret"
          }
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          autoComplete="off"
          required
        />
        <Input
          type="text"
          placeholder={`Owner ${provider === "github" ? "account id" : "sub"} (allowlisted)`}
          value={ownerId}
          onChange={(e) => setOwnerId(e.target.value)}
          autoComplete="off"
          required
        />
        {error ? (
          <p className="text-sm text-ink-accent" role="alert">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p className="flex items-center gap-2 text-sm text-foreground" role="status">
            Saved.{" "}
            <a className="text-ink-accent underline" href="/login">
              Verify by signing in
            </a>
          </p>
        ) : null}
        <Button type="submit" variant="primary" className="w-full justify-center" disabled={busy}>
          {busy ? "Saving…" : `Save ${LABEL[provider]}`}
        </Button>
      </form>
    </section>
  );
}
