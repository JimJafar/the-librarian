// Vault activity (rethink T21, spec §8 / D16) — the audit-trail page under
// the Vault section: the vault's recent git commits (files touched +
// subject-derived provenance) and the guarded "restore vault to here" flow.
// This view replaces the retired event ledger's logs view (D7/D16); the git
// history IS the audit trail.

import Link from "next/link";
import { commitDiffAction, restoreVaultAction } from "@/app/vault/activity/actions";
import { ActivityFeed } from "@/components/vault/activity-feed";
import type { VaultActivityEntry } from "@/components/vault/types";
import { serverTRPC } from "@/lib/trpc-server";

export const metadata = { title: "Vault activity · Librarian" };
export const dynamic = "force-dynamic";

export default async function VaultActivityPage() {
  let entries: VaultActivityEntry[] = [];
  let error: string | null = null;
  try {
    entries = await serverTRPC.activity.feed.query({ limit: 100 });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="flex flex-col gap-8 p-6">
      <header className="flex flex-col gap-3">
        <Link
          href="/"
          className="inline-flex w-fit items-center gap-1.5 text-xs text-foreground/60 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
        >
          <BackArrow />
          Vault
        </Link>
        <div className="flex flex-col gap-1.5">
          <h1 className="font-display text-xl text-foreground">Vault activity</h1>
          <p className="max-w-prose text-sm text-foreground/60">
            Every change to the vault, straight from its git history — this is the audit trail. Each
            commit can be restored to in one step.
          </p>
        </div>
      </header>

      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      <ActivityFeed
        entries={entries}
        onRestore={restoreVaultAction}
        onCommitDiff={commitDiffAction}
      />
    </main>
  );
}

function BackArrow() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 3 4 6l3 3" />
    </svg>
  );
}
