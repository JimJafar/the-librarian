// Primer settings (spec 041 A1, repointed by rethink T11). Hosts the
// primer — the one ≤2KB vault/primer.md document delivered when an agent
// connects (MCP initialize `instructions` + GET /primer.md). Reads the current
// primer server-side (the boot-seeded default on a fresh install) and renders
// the admin field. Gated like the rest of the dashboard. The Settings menu
// in the top nav covers the cross-page context — no page-level header here
// (the form's own Primer heading + subtitle carries all the meaning).

import { saveAwarenessPrimerAction } from "@/app/settings/primer/actions";
import { AwarenessPrimerForm } from "@/components/settings/awareness-primer-form";
import { serverTRPC } from "@/lib/trpc-server";

export const metadata = { title: "Primer · Librarian" };
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

export default async function PrimerSettingsPage() {
  const primer = await loadPrimer();

  return (
    <main className="flex flex-col gap-8 p-6">
      <AwarenessPrimerForm initial={primer} onSave={saveAwarenessPrimerAction} />
    </main>
  );
}
