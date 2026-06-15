"use client";

// Mobile detail-view: slides up from the bottom of the viewport
// instead of centering as a modal. Touch-native pattern that keeps
// the list scroll context intact (versus a full-screen takeover),
// while not eating the cool space at the very top a centered modal
// would.
//
// Built on Radix Dialog primitives so focus trap, Escape-to-close,
// backdrop-tap-to-close, and ARIA come for free. Only the
// positioning + the enter/exit transform differ from the standard
// editorial Dialog.
//
// Open height is 80vh — leaves a strip of the list visible so the
// operator can see they're still on the same page. Drag-to-dismiss
// is not wired (a real gesture handler would add weight for marginal
// gain; backdrop tap + Esc + the close button cover dismissal).
//
// Reduced motion: the slide collapses to a crossfade via the Tailwind
// animate-in / animate-out utilities (which already respect
// prefers-reduced-motion).

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { MemoryDetailContent } from "./memory-detail-content";
import type { MemoryRow } from "./types";
import { Pill } from "@/components/ui-v2/pill";

interface Props {
  memory: MemoryRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMutated: () => void;
}

export function MemoryBottomSheet({ memory, open, onOpenChange, onMutated }: Props) {
  // Render nothing when there's no memory to show — Radix expects a
  // non-null child when `open`, and the parent only opens the sheet
  // in response to a selection anyway.
  if (!memory) return null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col border-t border-ink-hairline bg-ink-surface text-foreground data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom"
        >
          {/* Drag handle pill — visual affordance for "this can be
              dismissed by gesture," even though we don't wire a drag
              listener. Touch convention. */}
          <div className="flex justify-center pt-2">
            <span aria-hidden className="h-1 w-10 rounded-full bg-foreground/20" />
          </div>

          <header className="flex items-start justify-between gap-2 border-b border-ink-hairline px-5 pb-3 pt-3">
            <div className="min-w-0">
              <DialogPrimitive.Title className="break-words font-display text-xl leading-tight text-foreground">
                {memory.title || <span className="italic text-foreground/55">(untitled)</span>}
              </DialogPrimitive.Title>
              {(memory.is_global || memory.requires_approval) && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {memory.is_global ? <Pill variant="muted">global</Pill> : null}
                  {memory.requires_approval ? <Pill variant="muted">requires approval</Pill> : null}
                </div>
              )}
            </div>
            <DialogPrimitive.Close
              aria-label="Close"
              className="-mr-2 -mt-1 inline-flex h-11 w-11 items-center justify-center text-foreground/55 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
            >
              <X className="h-5 w-5" aria-hidden />
            </DialogPrimitive.Close>
          </header>

          <div className="flex-1 overflow-y-auto p-5">
            <MemoryDetailContent
              memory={memory}
              onClose={() => onOpenChange(false)}
              onMutated={onMutated}
            />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
