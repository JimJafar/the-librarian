// Settings home (spec 041 A1, repointed by rethink T11). Currently hosts the
// primer — the one ≤2KB vault/primer.md document delivered when an agent
// connects (MCP initialize `instructions` + GET /primer.md). Reads the current
// primer server-side (the boot-seeded default on a fresh install) and renders
// the admin field. Gated like the rest of the dashboard. Authentication has
// its own sub-page (/settings/auth); this page links to it.

import Link from "next/link";
import { saveAwarenessPrimerAction } from "@/app/settings/actions";
import { AwarenessPrimerForm } from "@/components/settings/awareness-primer-form";
import { serverTRPC } from "@/lib/trpc-server";

export const metadata = { title: "Settings · Librarian" };
export const dynamic = "force-dynamic";

async function loadPrimer(): Promise<string> {
  try {
    const { primer } = await serverTRPC.awareness.primer.query();
    return primer;
  } catch {
    // Fail-soft: a transient read error shouldn't blank the page. The textarea
    // renders empty; saving will surface any persistent error.
    return "";
  }
}

export default async function SettingsPage() {
  const primer = await loadPrimer();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl text-foreground">Settings</h1>
        <p className="text-sm text-foreground/60">
          Server-sourced settings that take effect without a redeploy.{" "}
          <Link href="/settings/auth" className="underline">
            Authentication
          </Link>{" "}
          has its own page.
        </p>
      </header>

      <AwarenessPrimerForm initial={primer} onSave={saveAwarenessPrimerAction} />
    </main>
  );
}
