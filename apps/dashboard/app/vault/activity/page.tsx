// Vault activity (rethink T21, spec §8 / D16) — the audit-trail page under
// the Vault section: the vault's recent git commits (files touched +
// subject-derived provenance) and the guarded "restore vault to here" flow.
// This view replaces the retired event ledger's logs view (D7/D16); the git
// history IS the audit trail.

import Link from "next/link";
import { restoreVaultAction } from "@/app/vault/activity/actions";
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
    <main className="flex flex-col gap-4 p-6">
      <header className="flex flex-wrap items-baseline gap-3">
        <h1 className="font-display text-xl text-foreground">Vault activity</h1>
        <p className="text-sm text-muted-foreground">
          Every change to the vault, straight from its git history — this is the audit trail.
        </p>
        <Link href="/vault" className="ml-auto text-sm underline">
          Back to the vault
        </Link>
      </header>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <ActivityFeed entries={entries} onRestore={restoreVaultAction} />
    </main>
  );
}
