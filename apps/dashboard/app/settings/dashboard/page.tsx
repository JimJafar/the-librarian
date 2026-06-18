// Dashboard settings — server-level controls that aren't a curator job. Today
// this hosts server auto-update (spec 2026-06-16-server-autoupdate T4), moved
// off the Curator page so it lives with instance-level settings rather than a
// curation job. The dashboard only CONFIGURES auto-update; a timer on the host
// machine performs the update on the cadence set here (spec §2).

// `setAutoUpdateConfigAction` lives in the curator actions module (its only
// consumer now); it revalidates this route after a write.
import { setAutoUpdateConfigAction } from "@/app/curator/actions";
import { AutoUpdateConfigForm } from "@/components/curator/autoupdate-config-form";
import { SectionLabel } from "@/components/ui-v2/section-label";
import { serverTRPC } from "@/lib/trpc-server";

export const dynamic = "force-dynamic";

export default async function DashboardSettingsPage() {
  let autoupdate: Awaited<ReturnType<typeof serverTRPC.autoupdate.get.query>> | null = null;
  let error: string | null = null;
  try {
    autoupdate = await serverTRPC.autoupdate.get.query();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="flex flex-col gap-5 p-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-xl text-foreground">Dashboard</h1>
        <p className="text-sm text-foreground/60">
          Server-level settings for this Librarian instance.
        </p>
      </header>

      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          Failed to load settings: {error}
        </p>
      ) : null}

      {/* Server auto-update (spec 2026-06-16-server-autoupdate T4). The dashboard
          only configures it; the host timer performs the update (spec §2). */}
      <section className="flex flex-col gap-3" aria-label="Server auto-update">
        <header className="flex flex-col gap-1.5">
          <SectionLabel as="h2">Server auto-update</SectionLabel>
          <p className="text-sm text-foreground/60">
            Keep the server current automatically. The dashboard configures auto-update; a timer on
            the host machine performs the update on the cadence you set.
          </p>
        </header>
        {autoupdate ? (
          <AutoUpdateConfigForm
            enabled={autoupdate.enabled}
            cadence={autoupdate.cadence}
            lastRunAt={autoupdate.lastRunAt}
            version={autoupdate.version}
            latest={autoupdate.latest}
            onSave={setAutoUpdateConfigAction}
          />
        ) : null}
      </section>
    </main>
  );
}
