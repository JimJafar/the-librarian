// D5.1: the auth setup wizard. Gated like the rest of the dashboard (it's under
// /settings, which the middleware enforces when auth is on). Reads the current
// config server-side and renders the management cards. Only non-secret fields are
// surfaced — the OAuth client secrets and AUTH_SECRET in the config object are never
// written into the response.

import { serverTRPC } from "@/lib/trpc-server";

export const metadata = { title: "Authentication · Librarian" };

async function loadConfig() {
  try {
    return await serverTRPC.auth.config.query();
  } catch {
    return null;
  }
}

export default async function AuthSettingsPage() {
  const config = await loadConfig();
  const enabled = config?.enabled ?? false;
  const methods = config?.methods ?? [];

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl text-foreground">Authentication</h1>
        <p className="text-sm text-foreground/60">
          Configure how you sign in to this dashboard. Changes take effect without a redeploy.
        </p>
      </header>

      <section
        className="flex items-center justify-between rounded-lg border border-border bg-muted/20 px-4 py-3"
        aria-label="Authentication status"
      >
        <span className="text-sm text-foreground">Enforcement</span>
        <span
          className={`text-sm font-medium ${enabled ? "text-foreground" : "text-foreground/50"}`}
        >
          {enabled ? "Enabled" : "Disabled"}
        </span>
      </section>

      <p className="text-sm text-foreground/60">
        Configured methods: {methods.length ? methods.join(", ") : "none yet"}
      </p>

      {/* Cards land in D5.2 (enable) · D5.3 (password) · D5.4 (OAuth) · D5.5 (methods/disable). */}
    </main>
  );
}
