// Cmd-K command palette stub.
//
// D1.0 pins the open/close shape and the dialog role so the rest of
// the redesign can register actions against it. The actions registry,
// fuzzy search, and keyboard wiring all land in D1.4 — until then the
// dialog opens but only renders a placeholder line.

"use client";

import * as Dialog from "@radix-ui/react-dialog";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-foreground/20" />
        <Dialog.Content className="fixed left-1/2 top-[20%] z-50 w-[min(640px,90vw)] -translate-x-1/2 border border-foreground/15 bg-background p-4 font-sans">
          <Dialog.Title className="font-display text-lg text-foreground">
            Command palette
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-foreground/70">
            Actions register here in D1.4. Press Escape to close.
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
