"use client";

import { type FormEvent, useState } from "react";
import type { AuthActionResult } from "@/app/settings/auth/actions";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";

const MIN_LENGTH = 12;

// D5.3: set the owner username + password. Client-side checks (match + length) give
// immediate feedback; the store enforces the real length floor. The password is
// never echoed back from the server (the form only ever sends it).
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
    <section
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
      aria-label="Password login"
    >
      <h2 className="font-medium text-foreground">Password login</h2>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Input
          type="text"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
        />
        <Input
          type="password"
          placeholder={`New password (at least ${MIN_LENGTH} characters)`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={MIN_LENGTH}
          required
        />
        <Input
          type="password"
          placeholder="Confirm password"
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
        {saved ? (
          <p className="text-sm text-foreground" role="status">
            Password saved.
          </p>
        ) : null}
        <Button type="submit" variant="primary" className="w-full justify-center" disabled={busy}>
          {busy ? "Saving…" : "Save password"}
        </Button>
      </form>
    </section>
  );
}
