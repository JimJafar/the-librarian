import { FlaggedView } from "@/components/memories/flagged-view";

export const dynamic = "force-dynamic";

export default function FlaggedPage() {
  return (
    <main className="flex flex-col gap-5 p-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-xl text-foreground">Flagged</h1>
        <p className="text-sm text-foreground/60">
          Memories an agent has flagged for review. The flag stays open until an admin adjudicates
          here — Dismiss clears the flags and keeps the memory; Archive archives it and clears the
          flags.
        </p>
      </header>
      <FlaggedView />
    </main>
  );
}
