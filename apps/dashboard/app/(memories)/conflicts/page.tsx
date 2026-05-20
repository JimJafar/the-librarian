import { SimpleMemoryList } from "@/components/memories/simple-list";
import type { MemoryRow } from "@/components/memories/types";
import { serverTRPC } from "@/lib/trpc-server";

export const dynamic = "force-dynamic";

export default async function ConflictsPage() {
  let memories: MemoryRow[] = [];
  let error: string | null = null;
  try {
    const result = await serverTRPC.memories.list.query({
      status: "conflicted",
      limit: 100,
    } as Parameters<typeof serverTRPC.memories.list.query>[0]);
    memories = result.memories as MemoryRow[];
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return (
    <main className="flex flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Conflicts</h1>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <SimpleMemoryList memories={memories} emptyMessage="No conflicted memories." />
    </main>
  );
}
