"use client";

import { type FormEvent, useState } from "react";
import { redeemResetAction } from "@/app/settings/auth/reset/actions";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";

// D4.3: the one-time-link password reset form. The token comes from the URL; the
// owner sets a new password (and may change the username). On success it points back
// to /login. Errors (expired/used link, too-short password) surface inline.
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
      <div className="flex flex-col items-center gap-3 text-center">
        <p className="text-sm text-foreground" role="status">
          Password set. You can now sign in.
        </p>
        <a className="text-sm text-ink-accent underline" href="/login">
          Go to sign in
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-xs flex-col gap-3">
      <Input
        type="text"
        placeholder="Username (leave blank to keep current)"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoComplete="username"
      />
      <Input
        type="password"
        placeholder="New password (at least 12 characters)"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="new-password"
        minLength={12}
        required
      />
      <Input
        type="password"
        placeholder="Confirm new password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        autoComplete="new-password"
        required
      />
      {error ? (
        <p className="text-sm text-ink-accent" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" variant="primary" className="w-full justify-center" disabled={saving}>
        {saving ? "Setting…" : "Set password"}
      </Button>
    </form>
  );
}
