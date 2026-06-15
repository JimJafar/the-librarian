// Step 1 of the auth setup — sign-in methods.
//
// Replaces the three stacked rounded cards (password + GitHub + Google)
// with a single section that holds the Password form on the left and a
// tabbed OAuth panel on the right at md+. Both columns stay editable when
// enforcement is on (credential rotation is a real need; the Disable
// break-glass remains the only switch that revokes everyone).

"use client";

import { useState } from "react";
import { OAuthWizard } from "./oauth-wizard";
import { PasswordForm } from "./password-form";
import type { AuthActionResult } from "@/app/settings/auth/actions";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui-v2/tabs";

type SaveOAuth = (input: {
  clientId: string;
  clientSecret: string;
  ownerId: string;
}) => Promise<AuthActionResult>;

interface SignInMethodsProps {
  password: { username: string } | null;
  github: {
    ownerId: string | null;
    configured: boolean;
    callbackUrl: string;
    onSave: SaveOAuth;
  };
  google: {
    ownerId: string | null;
    configured: boolean;
    callbackUrl: string;
    onSave: SaveOAuth;
  };
  onSavePassword: (input: { username: string; password: string }) => Promise<AuthActionResult>;
}

export function SignInMethods({ password, github, google, onSavePassword }: SignInMethodsProps) {
  // Prefer GitHub when it's configured (the more common dev-audience choice),
  // fall back to Google if only Google is configured, else GitHub as the
  // empty-state default.
  const [tab, setTab] = useState<"github" | "google">(
    github.configured ? "github" : google.configured ? "google" : "github",
  );

  return (
    <section
      className="grid gap-10 md:grid-cols-2 md:gap-12"
      aria-label="Step one: configure a sign-in method"
    >
      <PasswordForm username={password?.username ?? null} onSave={onSavePassword} />

      <div className="flex flex-col gap-5">
        <header className="flex flex-col gap-1">
          <h3 className="font-display text-lg text-foreground">OAuth</h3>
          <p className="text-sm text-foreground/60">
            Sign in via a third-party identity provider. Only the allow-listed owner can pass.
          </p>
        </header>

        <Tabs value={tab} onValueChange={(value) => setTab(value as "github" | "google")}>
          <TabsList aria-label="OAuth provider">
            <TabsTrigger value="github">
              GitHub
              {github.configured ? (
                <span className="ml-1.5 text-ink-accent" aria-label="configured">
                  ●
                </span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="google">
              Google
              {google.configured ? (
                <span className="ml-1.5 text-ink-accent" aria-label="configured">
                  ●
                </span>
              ) : null}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="github">
            <OAuthWizard
              provider="github"
              callbackUrl={github.callbackUrl}
              ownerId={github.ownerId}
              configured={github.configured}
              onSave={github.onSave}
            />
          </TabsContent>
          <TabsContent value="google">
            <OAuthWizard
              provider="google"
              callbackUrl={google.callbackUrl}
              ownerId={google.ownerId}
              configured={google.configured}
              onSave={google.onSave}
            />
          </TabsContent>
        </Tabs>
      </div>
    </section>
  );
}
