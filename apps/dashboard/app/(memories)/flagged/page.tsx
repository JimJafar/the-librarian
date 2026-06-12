import { FlaggedView } from "@/components/memories/flagged-view";

export const dynamic = "force-dynamic";

export default function FlaggedPage() {
  return (
    <main className="flex flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Flagged</h1>
      <FlaggedView />
    </main>
  );
}
