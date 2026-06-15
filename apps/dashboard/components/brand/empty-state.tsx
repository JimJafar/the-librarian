// EmptyState — the composed empty / landing surface treatment. Brings
// together the brand triad (constellation backdrop + librarian figure
// + editorial copy) so landing screens earn their space rather than
// reading as "nothing here yet." Used wherever a surface has no
// selection or no records: /vault before a file is picked, future
// /memories / /handoffs / /proposals empty states.
//
// The figure is hero-scale on md+ (legible, anchored) and steps down
// on sm so mobile gets the iconography without crowding the copy.
// The constellation backdrop animates (`live`) — slow, ambient, the
// AI substrate quietly present.

import type { ReactNode } from "react";
import { ConstellationBackdrop } from "@/components/brand/constellation-backdrop";
import { LibrarianMark } from "@/components/brand/librarian-mark";

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  /** Optional action row — a Button or two, rendered below the copy
   *  with comfortable spacing. */
  action?: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      // Sharp-cornered frame with a brass gilt inner rule — the
      // "manuscript margin" reading. The constellation backdrop sits
      // behind everything; the figure and copy live above it.
      className="relative isolate flex min-h-[420px] flex-col items-center justify-center gap-6 overflow-hidden border border-ink-hairline px-6 py-12 text-center"
    >
      <ConstellationBackdrop live opacity={0.55} />
      {/* Brass gilt inner rule — the manuscript margin. 1px inset so
          it reads as edge detail, not as a second border competing
          with the hairline frame. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-2 border border-ink-copper-soft"
      />
      <div className="relative flex flex-col items-center gap-5">
        <LibrarianMark size="hero" className="opacity-95" />
        <h2 className="font-display text-2xl text-foreground text-balance max-w-[40ch]">{title}</h2>
        <div className="text-balance max-w-[55ch] text-sm leading-relaxed text-foreground/75">
          {children}
        </div>
        {action ? (
          <div className="flex flex-wrap items-center justify-center gap-2 pt-2">{action}</div>
        ) : null}
      </div>
    </section>
  );
}
