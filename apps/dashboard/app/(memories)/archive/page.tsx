import { ArchiveView } from "@/components/memories/archive-view";

export const dynamic = "force-dynamic";

export default function ArchivePage() {
  return (
    <main className="flex flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Archive</h1>
      <ArchiveView />
    </main>
  );
}
