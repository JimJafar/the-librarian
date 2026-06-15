"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import type { AuthActionResult } from "@/app/settings/auth/actions";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";
import { SectionLabel } from "@/components/ui-v2/section-label";

// Step 2 — Enforcement. Two states in one component:
//
//   off  →  admin-token input + "Enable enforcement" primary action,
//           with a precondition hint when no method is configured yet.
//   on   →  status line + "Pause authentication" destructive break-glass
//           (formerly "Disable authentication"). Inline confirm row, never
//           a modal.
//
// On Enable failure the admin-token field clears and re-focuses — a token
// that landed in a typo'd state shouldn't sit visible on screen.

interface EnforcementSectionProps {
  enabled: boolean;
  canEnable: boolean;
  onEnable: (adminToken: string) => Promise<AuthActionResult>;
  onDisable: () => Promise<AuthActionResult>;
}

export function EnforcementSection({
  enabled,
  canEnable,
  onEnable,
  onDisable,
}: EnforcementSectionProps) {
  return enabled ? (
    <EnabledState onDisable={onDisable} />
  ) : (
    <DisabledState canEnable={canEnable} onEnable={onEnable} />
  );
}

function DisabledState({
  canEnable,
  onEnable,
}: {
  canEnable: boolean;
  onEnable: (adminToken: string) => Promise<AuthActionResult>;
}) {
  const tokenRef = useRef<HTMLInputElement>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(id);
  }, [toast]);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const result = await onEnable(token);
    setBusy(false);
    if (result.ok) {
      setToken("");
      setToast("Authentication enabled.");
    } else {
      setError(result.error);
      // Clear the token field on failure so a wrong/typo'd token doesn't
      // sit visible. Re-focus so the operator can try again immediately.
      setToken("");
      tokenRef.current?.focus();
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" aria-label="Enable enforcement">
      <div className="flex flex-col gap-1.5">
        <SectionLabel as="label" htmlFor="auth-admin-token">
          Admin token
        </SectionLabel>
        <Input
          id="auth-admin-token"
          ref={tokenRef}
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
          required
          disabled={!canEnable}
        />
        <p className="text-xs text-foreground/60">
          The <code className="font-mono text-foreground/80">LIBRARIAN_ADMIN_TOKEN</code> value set
          on the server.
        </p>
      </div>

      {!canEnable ? (
        <p
          role="status"
          className="border border-foreground/15 bg-foreground/[0.03] p-3 text-sm text-foreground/70"
        >
          Configure at least one sign-in method above before turning enforcement on. Enforcement
          without a working method would lock you out.
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {toast ? (
        <p
          role="status"
          className="border border-ink-accent/40 bg-ink-accent/[0.06] p-3 text-sm text-foreground"
        >
          {toast}
        </p>
      ) : null}

      <Button type="submit" variant="primary" className="self-start" disabled={busy || !canEnable}>
        {busy ? "Enabling…" : "Enable enforcement"}
      </Button>
    </form>
  );
}

function EnabledState({ onDisable }: { onDisable: () => Promise<AuthActionResult> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function disable(): Promise<void> {
    setError(null);
    setBusy(true);
    const result = await onDisable();
    setBusy(false);
    if (result.ok) {
      setConfirming(false);
    } else {
      // Keep the confirm visible on failure — a break-glass control must
      // never silently leave the owner believing enforcement is off when
      // it isn't.
      setError(result.error);
    }
  }

  return (
    <div className="flex flex-col gap-4" aria-label="Enforcement status">
      <p className="text-sm text-foreground">
        Authentication is currently on. The dashboard requires a sign-in to read or write.
      </p>

      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      <div className="flex justify-end pt-2">
        {confirming ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-foreground/70">
              Pause authentication? Methods stay configured; you can re-enable any time.
            </span>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={disable} disabled={busy}>
              {busy ? "Pausing…" : "Pause authentication"}
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="ghost"
            className="text-destructive hover:bg-destructive/[0.06]"
            onClick={() => setConfirming(true)}
          >
            Pause authentication →
          </Button>
        )}
      </div>
    </div>
  );
}
