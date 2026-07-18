import { LibrarianMark } from "@/components/brand/librarian-mark";

export default function ClaimLoading() {
  return (
    <main
      className="flex min-h-screen flex-col items-center justify-center gap-8 p-6"
      aria-busy="true"
      aria-label="Loading claim status"
    >
      <div className="flex flex-col items-center gap-4 text-center">
        <LibrarianMark size="rail" />
        <div className="flex flex-col items-center gap-1.5">
          <h1 className="font-display text-xl text-foreground">Claim this Librarian</h1>
          <p className="text-sm text-foreground/60">
            Checking whether first-owner claiming is armed…
          </p>
        </div>
      </div>
      <div className="flex w-full max-w-sm flex-col gap-5" aria-hidden="true">
        <div className="h-12 border-b border-ink-hairline bg-ink-mono-fill/50" />
        <div className="h-12 border-b border-ink-hairline bg-ink-mono-fill/50" />
        <div className="h-9 border border-ink-hairline bg-ink-surface/50" />
      </div>
    </main>
  );
}
