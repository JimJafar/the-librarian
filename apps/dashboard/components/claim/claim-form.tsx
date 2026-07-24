"use client";

import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";
import { SectionLabel } from "@/components/ui-v2/section-label";
import type { ClaimRedemptionResult } from "@/lib/claim-redemption";

type ClaimFormState = { status: "idle" } | Exclude<ClaimRedemptionResult, { status: "redirect" }>;

const INITIAL_STATE: ClaimFormState = { status: "idle" };
const MIN_PASSWORD_LENGTH = 12;

export function ClaimForm({ token, email }: { token: string; email: string }) {
  const [state, setState] = useState<ClaimFormState>(INITIAL_STATE);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    try {
      const formData = new FormData(event.currentTarget);
      const response = await fetch("/api/claim/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          password: formData.get("password"),
          confirm: formData.get("confirm"),
        }),
        cache: "no-store",
        // The body carries the claim token and new owner password; a 3xx from a
        // misconfigured edge must fail closed, never re-send them elsewhere.
        redirect: "error",
      });
      const result = (await response.json()) as ClaimRedemptionResult;
      if (result.status === "redirect") {
        window.location.assign(result.location);
        return;
      }
      if (result.status === "claimed" || result.status === "error") {
        setState(result);
        return;
      }
      throw new Error("unexpected claim response");
    } catch {
      setState({
        status: "error",
        error: "The claim could not be completed. Please wait and try again.",
      });
    } finally {
      setPending(false);
    }
  }

  if (state.status === "claimed") {
    return (
      <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
        <p
          role="status"
          className="w-full border border-ink-accent/40 bg-ink-accent/[0.06] p-4 text-sm text-foreground"
        >
          Owner account created. The automatic sign-in did not complete, but your claim is safe.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm">
          <a
            className="text-ink-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
            href={state.loginHref}
          >
            Go to sign in →
          </a>
          {state.continueUrl ? (
            <a
              className="text-foreground/70 underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
              href={state.continueUrl}
              rel="noreferrer"
            >
              Continue to provisioning →
            </a>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <SectionLabel as="label" htmlFor="claim-email">
          Owner email
        </SectionLabel>
        <Input
          id="claim-email"
          type="email"
          value={email}
          readOnly
          autoComplete="username"
          aria-describedby="claim-email-note"
        />
        <p id="claim-email-note" className="text-xs text-foreground/60">
          Supplied by your signed claim. It cannot be changed here.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <SectionLabel as="label" htmlFor="claim-password">
          New password
        </SectionLabel>
        <Input
          id="claim-password"
          type="password"
          name="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
          aria-describedby="claim-password-note"
        />
        <p id="claim-password-note" className="text-xs text-foreground/60">
          At least {MIN_PASSWORD_LENGTH} characters.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <SectionLabel as="label" htmlFor="claim-confirm">
          Confirm new password
        </SectionLabel>
        <Input
          id="claim-confirm"
          type="password"
          name="confirm"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
        />
      </div>

      {state.status === "error" ? (
        <p
          role="alert"
          aria-live="assertive"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          {state.error}
        </p>
      ) : null}

      <Button type="submit" variant="primary" className="w-full justify-center" disabled={pending}>
        {pending ? "Claiming…" : "Claim this Librarian"}
      </Button>
    </form>
  );
}
