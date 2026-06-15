"use client";

import { type FormEvent, useEffect, useState } from "react";
import type { AuthActionResult } from "@/app/settings/auth/actions";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";
import { SectionLabel } from "@/components/ui-v2/section-label";

const MIN_LENGTH = 12;

// D5.3 — Password method form. Real <label> elements (via SectionLabel
// as="label") restore the field labels the placeholder-only form was
// missing. The form lives chromeless: its parent (sign-in-methods) owns
// the section container so adjacent panels read as one rhythm.

export function PasswordForm({
  username: currentUsername,
  onSave,
}: {
  username: string | null;
  onSave: (input: { username: string; password: string }) => Promise<AuthActionResult>;
}) {
  const [username, setUsername] = useState(currentUsername ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Five-second auto-dismiss matches the archive-view inline toast pattern.
  // (A real toast library lands later; this keeps the surfaces consistent.)
  useEffect(() => {
    if (!saved) return;
    const id = window.setTimeout(() => setSaved(false), 5000);
    return () => window.clearTimeout(id);
  }, [saved]);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSaved(false);
    if (password.length < MIN_LENGTH) {
      setError(`Password must be at least ${MIN_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    const result = await onSave({ username: username.trim(), password });
    setBusy(false);
    if (result.ok) {
      setSaved(true);
      setPassword("");
      setConfirm("");
    } else {
      setError(result.error);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-5"
      aria-label="Password login"
      noValidate
    >
      <header className="flex flex-col gap-1">
        <h3 className="font-display text-lg text-foreground">Password</h3>
        <p className="text-sm text-foreground/60">
          A username and a passphrase. Set once, change any time.
        </p>
      </header>

      <div className="flex flex-col gap-1.5">
        <SectionLabel as="label" htmlFor="auth-password-username">
          Username
        </SectionLabel>
        <Input
          id="auth-password-username"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <SectionLabel as="label" htmlFor="auth-password-new">
          New password
        </SectionLabel>
        <Input
          id="auth-password-new"
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
        <SectionLabel as="label" htmlFor="auth-password-confirm">
          Confirm password
        </SectionLabel>
        <Input
          id="auth-password-confirm"
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
      {saved ? (
        <p
          role="status"
          className="border border-ink-accent/40 bg-ink-accent/[0.06] p-3 text-sm text-foreground"
        >
          Password saved.
        </p>
      ) : null}

      <Button type="submit" variant="primary" className="self-start" disabled={busy}>
        {busy ? "Saving…" : "Save password"}
      </Button>
    </form>
  );
}
