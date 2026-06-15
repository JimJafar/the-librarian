"use client";

import { type FormEvent, useState } from "react";
import { redeemResetAction } from "@/app/settings/auth/reset/actions";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";
import { SectionLabel } from "@/components/ui-v2/section-label";

const MIN_LENGTH = 12;

// D4.3 — One-time-link password reset. The token comes from the URL; the
// owner sets a new password (and may change the username). On success it
// points back to /login. Errors (expired/used link, too-short password)
// surface inline in the editorial red-ochre callout.

export function ResetForm({ token }: { token: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setSaving(true);
    const trimmed = username.trim();
    const result = await redeemResetAction({
      token,
      password,
      ...(trimmed ? { username: trimmed } : {}),
    });
    setSaving(false);
    if (result.ok) setDone(true);
    else setError(result.error);
  }

  if (done) {
    return (
      <div className="flex w-full max-w-xs flex-col items-center gap-4 text-center">
        <p
          role="status"
          className="w-full border border-ink-accent/40 bg-ink-accent/[0.06] p-3 text-sm text-foreground"
        >
          Password set. You can now sign in.
        </p>
        <a className="text-sm text-ink-accent underline-offset-2 hover:underline" href="/login">
          Go to sign in →
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-xs flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <SectionLabel as="label" htmlFor="reset-username">
          Username
        </SectionLabel>
        <Input
          id="reset-username"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          placeholder="Leave blank to keep current"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <SectionLabel as="label" htmlFor="reset-password">
          New password
        </SectionLabel>
        <Input
          id="reset-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={MIN_LENGTH}
          required
        />
        <p className="text-xs text-foreground/60">At least {MIN_LENGTH} characters.</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <SectionLabel as="label" htmlFor="reset-confirm">
          Confirm new password
        </SectionLabel>
        <Input
          id="reset-confirm"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
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

      <Button type="submit" variant="primary" className="w-full justify-center" disabled={saving}>
        {saving ? "Setting…" : "Set password"}
      </Button>
    </form>
  );
}
