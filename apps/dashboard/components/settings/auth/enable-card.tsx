"use client";

import { type FormEvent, useState } from "react";
import type { AuthActionResult } from "@/app/settings/auth/actions";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";

// D5.2: the "enable authentication" card. Enabling requires the admin token (the
// land-grab guard) AND at least one configured method, so the button is disabled
// until a method exists. A wrong token / incomplete config surfaces as an error.
export function EnableCard({
  enabled,
  canEnable,
  onEnable,
}: {
  enabled: boolean;
  canEnable: boolean;
  onEnable: (adminToken: string) => Promise<AuthActionResult>;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const result = await onEnable(token);
    setBusy(false);
    if (result.ok) setToken("");
    else setError(result.error);
  }

  if (enabled) {
    return (
      <section className="rounded-lg border border-border p-4" aria-label="Enable authentication">
        <p className="text-sm text-foreground" role="status">
          Authentication is enabled.
        </p>
      </section>
    );
  }

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
      aria-label="Enable authentication"
    >
      <div className="flex flex-col gap-1">
        <h2 className="font-medium text-foreground">Enable authentication</h2>
        <p className="text-sm text-foreground/60">
          Paste the admin token (printed once on first boot, or at
          <code> ${"{DATA_DIR}"}/admin.token</code>) to turn on enforcement.
        </p>
      </div>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Input
          type="password"
          placeholder="Admin token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
          required
        />
        {!canEnable ? (
          <p className="text-sm text-foreground/60">Configure at least one login method first.</p>
        ) : null}
        {error ? (
          <p className="text-sm text-ink-accent" role="alert">
            {error}
          </p>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          className="w-full justify-center"
          disabled={busy || !canEnable}
        >
          {busy ? "Enabling…" : "Enable authentication"}
        </Button>
      </form>
    </section>
  );
}
