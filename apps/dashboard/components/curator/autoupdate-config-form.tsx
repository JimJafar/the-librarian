"use client";

// Server auto-update config (spec 2026-06-16-server-autoupdate T4). Enable +
// cadence, a read-only status line (last auto-update + an up-to-date /
// update-available badge), and the SC6 host hint.
//
// IMPORTANT (spec §2 / SC6): the dashboard only CONFIGURES auto-update — it
// writes the `enabled`/`cadence` settings via the admin tRPC `autoupdate.set`.
// It never PERFORMS an update: a process inside the container can't recreate its
// own container. The host-installed timer (`librarian server autoupdate enable`)
// is what acts. So this form has no "update now" button by design — only the
// toggle, the cadence, and a calm note that the settings take effect only once
// the host timer is installed.
//
// Editorial rebuild mirroring IntakeConfigForm — no card chrome (the parent
// section owns the container); SectionLabel field labels, ui-v2 Select + Button,
// accent checkbox. The version/latest pair is rendered by the same status logic
// the top-bar VersionBadge uses (one source of truth, see ./autoupdate-status).

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { SaveConfigResult } from "@/app/curator/actions";
import { type LatestReleaseStatus, autoUpdateStatus } from "@/components/curator/autoupdate-status";
import { Button } from "@/components/ui-v2/button";
import { Pill } from "@/components/ui-v2/pill";
import { SectionLabel } from "@/components/ui-v2/section-label";
import { Select } from "@/components/ui-v2/select";

type Cadence = "daily" | "weekly";

const STATUS_LABEL: Record<ReturnType<typeof autoUpdateStatus>, string> = {
  loading: "Checking…",
  up_to_date: "Up to date",
  behind: "Update available",
  unknown: "Version unknown",
};

// Up-to-date wears the rubric accent (positive, the one lit state on the line);
// behind wears copper (important hardware-tier, never destructive) — the same
// tier/colours the top-bar VersionBadge uses.
const STATUS_PILL: Record<ReturnType<typeof autoUpdateStatus>, "accent" | "default"> = {
  loading: "default",
  up_to_date: "accent",
  behind: "default",
  unknown: "default",
};

function formatLastRun(lastRunAt: string | null): string {
  if (!lastRunAt) return "never";
  const date = new Date(lastRunAt);
  if (Number.isNaN(date.getTime())) return lastRunAt;
  // Editorial: a human, locale-stable timestamp. `toISOString`'s date + minute
  // is precise without leaking milliseconds.
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/:\d\d\.\d+Z$/, " UTC");
}

export function AutoUpdateConfigForm({
  enabled: initialEnabled,
  cadence: initialCadence,
  lastRunAt,
  version,
  latest,
  onSave,
}: {
  enabled: boolean;
  cadence: Cadence;
  lastRunAt: string | null;
  version: string;
  latest: LatestReleaseStatus | undefined;
  onSave: (input: { enabled?: boolean; cadence?: Cadence }) => Promise<SaveConfigResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [cadence, setCadence] = useState<Cadence>(initialCadence);

  useEffect(() => {
    if (!saved) return;
    const id = window.setTimeout(() => setSaved(false), 5000);
    return () => window.clearTimeout(id);
  }, [saved]);

  const clearStatus = () => {
    setSaved(false);
    setError(null);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    clearStatus();
    startTransition(async () => {
      const result = await onSave({ enabled, cadence });
      if (result.ok) {
        setSaved(true);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  const status = autoUpdateStatus(version, latest);

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4"
      aria-label="Auto-update configuration form"
      noValidate
    >
      <label className="inline-flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            clearStatus();
          }}
          className="h-4 w-4 accent-ink-accent"
        />
        Enable automatic server updates
      </label>

      <div className="flex flex-col gap-1.5">
        <SectionLabel as="label" htmlFor="autoupdate-cadence">
          Cadence
        </SectionLabel>
        <Select
          id="autoupdate-cadence"
          aria-label="Cadence"
          className="w-40"
          value={cadence}
          onChange={(e) => {
            setCadence(e.target.value as Cadence);
            clearStatus();
          }}
        >
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </Select>
        <p className="text-xs text-foreground/60">
          How often the host timer checks whether an update is due.
        </p>
      </div>

      {/* Read-only status line: last auto-update + the version/latest badge. */}
      <dl className="flex flex-col gap-1.5 text-sm text-foreground">
        <div className="flex flex-wrap items-baseline gap-2">
          <dt className="text-foreground/60">Last auto-update:</dt>
          <dd data-testid="autoupdate-last-run" className="font-mono text-xs">
            {formatLastRun(lastRunAt)}
          </dd>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <dt className="text-foreground/60">Server version:</dt>
          <dd className="flex items-center gap-2">
            <span className="font-mono text-xs">v{version}</span>
            <Pill
              variant={STATUS_PILL[status]}
              data-testid="autoupdate-version-badge"
              data-status={status}
            >
              {STATUS_LABEL[status]}
            </Pill>
          </dd>
        </div>
      </dl>

      {/* SC6 host hint — calm, not alarming. The settings above only take effect
          once the host timer is installed; the dashboard can't install it (the
          container can't manage the host). */}
      <p
        data-testid="autoupdate-host-hint"
        className="border-l-2 border-ink-copper-soft pl-3 text-xs text-foreground/60"
      >
        These settings only take effect once the auto-update timer is installed on the host. Run{" "}
        <code className="rounded-none bg-foreground/[0.06] px-1 py-0.5 font-mono text-foreground/80">
          librarian server autoupdate enable
        </code>{" "}
        on the host machine — the dashboard configures auto-update but can&rsquo;t install a host
        timer from inside the container.
      </p>

      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          Error: {error}
        </p>
      ) : null}
      {saved ? (
        <p
          role="status"
          className="border border-ink-accent/40 bg-ink-accent/[0.06] p-3 text-sm text-foreground"
        >
          Saved.
        </p>
      ) : null}

      <Button type="submit" variant="primary" className="self-start" disabled={pending}>
        {pending ? "Saving…" : "Save auto-update"}
      </Button>
    </form>
  );
}
