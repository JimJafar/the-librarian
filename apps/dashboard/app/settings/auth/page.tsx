// D5 — the auth setup surface. Reads the current config server-side; only
// non-secret fields cross the server-client boundary (OAuth client secrets
// + AUTH_SECRET stay on the server).
//
// IA (Phase 3 redesign): a top Status strip summarising enforcement +
// configured methods, then Step One (sign-in methods, password ⟷ OAuth
// tabs) and Step Two (enforcement gate). The two numbered preambles earn
// their place because there's a real dependency — you can't enable
// without a method.

import { headers } from "next/headers";
import {
  disableAuthAction,
  enableAuthAction,
  saveOAuthAction,
  setPasswordAction,
} from "@/app/settings/auth/actions";
import { EnforcementSection } from "@/components/settings/auth/enforcement-section";
import type { AuthMethod } from "@/components/settings/auth/methods";
import { SignInMethods } from "@/components/settings/auth/sign-in-methods";
import { StatusStrip } from "@/components/settings/auth/status-strip";
import { SectionLabel } from "@/components/ui-v2/section-label";
import { serverTRPC } from "@/lib/trpc-server";

export const metadata = { title: "Authentication · Librarian" };

async function loadConfig() {
  try {
    return await serverTRPC.auth.config.query();
  } catch {
    return null;
  }
}

async function resolveOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export default async function AuthSettingsPage() {
  const config = await loadConfig();
  const origin = await resolveOrigin();
  const enabled = config?.enabled ?? false;
  const methods = (config?.methods ?? []) as readonly AuthMethod[];
  const canEnable = methods.length > 0;

  return (
    <main className="flex flex-col gap-10 p-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-xl text-foreground">Authentication</h1>
        <p className="text-sm text-foreground/60">
          Configure how you sign in to this dashboard. Changes take effect without a redeploy.
        </p>
      </header>

      <StatusStrip enabled={enabled} methods={methods} ready={canEnable} />

      <section className="flex flex-col gap-6" aria-labelledby="step-one-heading">
        <header className="flex flex-col gap-1.5">
          <SectionLabel as="p">Step one</SectionLabel>
          <h2 id="step-one-heading" className="font-display text-lg text-foreground">
            Sign-in methods
          </h2>
          <p className="max-w-prose text-sm text-foreground/60">
            Configure at least one. You can use both — password is fastest to set up; OAuth lets you
            reuse an existing identity.
          </p>
        </header>

        <SignInMethods
          password={config?.password ?? null}
          github={{
            ownerId: config?.ownerOAuth?.github ?? null,
            configured: !!config?.oauth?.github,
            callbackUrl: `${origin}/api/auth/callback/github`,
            onSave: saveOAuthAction.bind(null, "github"),
          }}
          google={{
            ownerId: config?.ownerOAuth?.google ?? null,
            configured: !!config?.oauth?.google,
            callbackUrl: `${origin}/api/auth/callback/google`,
            onSave: saveOAuthAction.bind(null, "google"),
          }}
          onSavePassword={setPasswordAction}
        />
      </section>

      <section
        className="flex flex-col gap-6 border-t border-ink-hairline pt-10"
        aria-labelledby="step-two-heading"
      >
        <header className="flex flex-col gap-1.5">
          <SectionLabel as="p">Step two</SectionLabel>
          <h2 id="step-two-heading" className="font-display text-lg text-foreground">
            Enforcement
          </h2>
          <p className="max-w-prose text-sm text-foreground/60">
            Turn the gate on with your{" "}
            <code className="font-mono text-foreground/80">LIBRARIAN_ADMIN_TOKEN</code>. Once on,
            every dashboard route requires a sign-in.
          </p>
        </header>

        <EnforcementSection
          enabled={enabled}
          canEnable={canEnable}
          onEnable={enableAuthAction}
          onDisable={disableAuthAction}
        />
      </section>
    </main>
  );
}
