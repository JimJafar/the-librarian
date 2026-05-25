// D5: the auth setup wizard. Gated like the rest of the dashboard (it's under
// /settings, which the middleware enforces when auth is on). Reads the current
// config server-side and renders the management cards. Only non-secret fields are
// surfaced — the OAuth client secrets and AUTH_SECRET in the config object are never
// passed to the client components.

import { headers } from "next/headers";
import {
  disableAuthAction,
  enableAuthAction,
  saveOAuthAction,
  setPasswordAction,
} from "@/app/settings/auth/actions";
import { EnableCard } from "@/components/settings/auth/enable-card";
import { MethodsPanel } from "@/components/settings/auth/methods-panel";
import { OAuthWizard } from "@/components/settings/auth/oauth-wizard";
import { PasswordForm } from "@/components/settings/auth/password-form";
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
  const methods = config?.methods ?? [];
  const canEnable = methods.length > 0;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl text-foreground">Authentication</h1>
        <p className="text-sm text-foreground/60">
          Configure how you sign in to this dashboard. Changes take effect without a redeploy.
        </p>
      </header>

      <EnableCard enabled={enabled} canEnable={canEnable} onEnable={enableAuthAction} />

      <PasswordForm username={config?.password?.username ?? null} onSave={setPasswordAction} />

      <OAuthWizard
        provider="github"
        callbackUrl={`${origin}/api/auth/callback/github`}
        ownerId={config?.ownerOAuth?.github ?? null}
        configured={!!config?.oauth?.github}
        onSave={saveOAuthAction.bind(null, "github")}
      />
      <OAuthWizard
        provider="google"
        callbackUrl={`${origin}/api/auth/callback/google`}
        ownerId={config?.ownerOAuth?.google ?? null}
        configured={!!config?.oauth?.google}
        onSave={saveOAuthAction.bind(null, "google")}
      />

      <MethodsPanel
        enabled={enabled}
        methods={{
          password: config?.password ?? null,
          github: config?.oauth?.github ? { ownerId: config.ownerOAuth?.github ?? null } : null,
          google: config?.oauth?.google ? { ownerId: config.ownerOAuth?.google ?? null } : null,
        }}
        onDisable={disableAuthAction}
      />
    </main>
  );
}
