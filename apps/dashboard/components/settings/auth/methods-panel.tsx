"use client";

import { useState } from "react";
import type { AuthActionResult } from "@/app/settings/auth/actions";
import { Button } from "@/components/ui-v2/button";

export interface AuthMethodsView {
  password: { username: string } | null;
  github: { ownerId: string | null } | null;
  google: { ownerId: string | null } | null;
}

// D5.5: lists the configured methods + owner identities (never secrets) and offers a
// confirmed "disable authentication" break-glass.
export function MethodsPanel({
  enabled,
  methods,
  onDisable,
}: {
  enabled: boolean;
  methods: AuthMethodsView;
  onDisable: () => Promise<AuthActionResult>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const rows: string[] = [];
  if (methods.password) rows.push(`Password — ${methods.password.username}`);
  if (methods.github) rows.push(`GitHub — ${methods.github.ownerId ?? "(no owner set)"}`);
  if (methods.google) rows.push(`Google — ${methods.google.ownerId ?? "(no owner set)"}`);

  async function disable(): Promise<void> {
    setBusy(true);
    await onDisable();
    setBusy(false);
    setConfirming(false);
  }

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
      aria-label="Configured methods"
    >
      <h2 className="font-medium text-foreground">Configured methods</h2>
      {rows.length ? (
        <ul className="flex flex-col gap-1 text-sm text-foreground/80">
          {rows.map((row) => (
            <li key={row}>{row}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-foreground/60">No methods configured yet.</p>
      )}

      {enabled ? (
        confirming ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-foreground/70">Disable enforcement?</span>
            <Button variant="primary" onClick={disable} disabled={busy}>
              {busy ? "Disabling…" : "Confirm disable"}
            </Button>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button variant="outline" className="self-start" onClick={() => setConfirming(true)}>
            Disable authentication
          </Button>
        )
      ) : null}
    </section>
  );
}
