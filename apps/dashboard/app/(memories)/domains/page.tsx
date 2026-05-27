import { DomainList } from "@/components/domains/domain-list";
import { serverTRPC } from "@/lib/trpc-server";

export const dynamic = "force-dynamic";

export default async function DomainsPage() {
  const domains = await serverTRPC.domains.list.query();
  return (
    <main className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Domains</h1>
        <p className="text-sm text-muted-foreground">
          Owner-curated list. New conversations inherit one of these via the signal-precedence chain
          or an explicit pick. Removing a non-floor domain reassigns its memories to{" "}
          <code>general</code>.
        </p>
      </header>
      <DomainList initial={domains} />
    </main>
  );
}
