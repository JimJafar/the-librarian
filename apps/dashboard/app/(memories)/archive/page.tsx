import { ArchiveView } from "@/components/memories/archive-view";

export const dynamic = "force-dynamic";

export default function ArchivePage() {
  return (
    <main className="flex flex-col gap-5 p-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-xl text-foreground">Archive</h1>
        <p className="text-sm text-foreground/60">
          Memories archived from the active corpus. They stay here until permanently deleted — which
          is irreversible and admin-only.
        </p>
      </header>
      <ArchiveView />
    </main>
  );
}
