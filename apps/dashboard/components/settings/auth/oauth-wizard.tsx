"use client";

import { type FormEvent, useEffect, useState } from "react";
import type { AuthActionResult } from "@/app/settings/auth/actions";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";
import { SectionLabel } from "@/components/ui-v2/section-label";

const LABEL: Record<"github" | "google", string> = { github: "GitHub", google: "Google" };
const OWNER_HINT: Record<"github" | "google", string> = {
  github: "Your numeric GitHub user id. Find it at api.github.com/users/<your-username>.",
  google: "Your Google account's `sub` claim. Find it on jwt.io after a one-time sign-in.",
};

// D5.4 — Configure one OAuth provider. The form is wrapped in a parent
// <Tabs> in sign-in-methods.tsx, so it renders chromeless: no card border,
// no heading (the tab IS the heading).
//
// Secrets are write-only on this surface — the saved-client-secret is never
// rendered back to the form, and the placeholder makes "leave blank to keep"
// explicit when the provider is already configured.

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

  useEffect(() => {
    if (!saved) return;
    const id = window.setTimeout(() => setSaved(false), 8000);
    return () => window.clearTimeout(id);
  }, [saved]);

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

  const fieldPrefix = `auth-oauth-${provider}`;

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-5"
      aria-label={`${LABEL[provider]} OAuth`}
      noValidate
    >
      <div className="flex flex-col gap-1.5">
        <SectionLabel as="div">Register this callback URL with {LABEL[provider]}</SectionLabel>
        <code className="break-all border-b border-ink-hairline bg-foreground/[0.04] px-2 py-1.5 font-mono text-xs text-foreground">
          {callbackUrl}
        </code>
      </div>

      <div className="flex flex-col gap-1.5">
        <SectionLabel as="label" htmlFor={`${fieldPrefix}-client-id`}>
          Client ID
        </SectionLabel>
        <Input
          id={`${fieldPrefix}-client-id`}
          type="text"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          autoComplete="off"
          required={!configured}
          placeholder={configured ? "Leave blank to keep current" : undefined}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <SectionLabel as="label" htmlFor={`${fieldPrefix}-client-secret`}>
          Client secret
        </SectionLabel>
        <Input
          id={`${fieldPrefix}-client-secret`}
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          autoComplete="off"
          required={!configured}
          placeholder={configured ? "Leave blank to keep current" : undefined}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <SectionLabel as="label" htmlFor={`${fieldPrefix}-owner`}>
          Owner {provider === "github" ? "account id" : "subject (sub)"}
        </SectionLabel>
        <Input
          id={`${fieldPrefix}-owner`}
          type="text"
          value={ownerId}
          onChange={(e) => setOwnerId(e.target.value)}
          autoComplete="off"
          required
        />
        <p className="text-xs text-foreground/60">{OWNER_HINT[provider]}</p>
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
          className="flex flex-wrap items-center gap-x-2 gap-y-1 border border-ink-accent/40 bg-ink-accent/[0.06] p-3 text-sm text-foreground"
        >
          <span>Saved.</span>
          <a className="text-ink-accent underline-offset-2 hover:underline" href="/login">
            Verify by signing in →
          </a>
        </p>
      ) : null}

      <Button type="submit" variant="primary" className="self-start" disabled={busy}>
        {busy ? "Saving…" : `Save ${LABEL[provider]}`}
      </Button>
    </form>
  );
}
