import { ProposalsView } from "@/components/memories/proposals-view";
import type { MemoryRow } from "@/components/memories/types";
import { serverTRPC } from "@/lib/trpc-server";

export const dynamic = "force-dynamic";

export default async function ProposalsPage() {
  let memories: MemoryRow[] = [];
  let error: string | null = null;
  try {
    const result = await serverTRPC.memories.list.query({
      status: "proposed",
      limit: 100,
    } as Parameters<typeof serverTRPC.memories.list.query>[0]);
    memories = result.memories as MemoryRow[];
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return (
    <main className="flex flex-col gap-5 p-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-xl text-foreground">Proposals</h1>
        <p className="text-sm text-foreground/60">
          Memories the resident curator wants to save. Approve to keep them in the active corpus, or
          reject to discard them.
        </p>
      </header>
      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          Failed to load proposals: {error}
        </p>
      ) : null}
      <ProposalsView memories={memories} />
    </main>
  );
}
