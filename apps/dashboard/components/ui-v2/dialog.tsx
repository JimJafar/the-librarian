// U1 — editorial Dialog wrapper around Radix Dialog.
//
// Mirrors the Radix shape (Root + Trigger + Portal + Overlay + Content
// + Header/Title/Description/Footer) so it can drop in wherever the
// legacy `@/components/ui/dialog` was imported. The chrome is the
// editorial direction: hairline border, ink-surface fill, serif title,
// no drop shadow. Pairs with U3's deletion of the hand-rolled wrapper
// in rehome-modal.tsx.

"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type HTMLAttributes } from "react";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function DialogOverlay({ className = "", ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={`fixed inset-0 z-50 bg-foreground/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:transition-none motion-reduce:data-[state=closed]:animate-none motion-reduce:data-[state=open]:animate-none ${className}`.trim()}
      {...props}
    />
  );
});

const DialogContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(function DialogContent({ className = "", children, ...props }, ref) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={`fixed left-1/2 top-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 border border-ink-hairline bg-ink-surface p-6 text-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:transition-none motion-reduce:data-[state=closed]:animate-none motion-reduce:data-[state=open]:animate-none ${className}`.trim()}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          aria-label="Close"
          className="absolute right-4 top-4 inline-flex h-6 w-6 items-center justify-center text-foreground/60 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
        >
          <X className="h-4 w-4" aria-hidden />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});

function DialogHeader({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`flex flex-col gap-1 border-b border-ink-hairline pb-3 ${className}`.trim()}
      {...props}
    />
  );
}

function DialogFooter({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`flex flex-col-reverse gap-2 border-t border-ink-hairline pt-3 sm:flex-row sm:justify-end ${className}`.trim()}
      {...props}
    />
  );
}

const DialogTitle = forwardRef<
  HTMLHeadingElement,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className = "", ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={`font-display text-lg leading-tight tracking-tight text-foreground ${className}`.trim()}
      {...props}
    />
  );
});

const DialogDescription = forwardRef<
  HTMLParagraphElement,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className = "", ...props }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={`text-sm text-foreground/70 ${className}`.trim()}
      {...props}
    />
  );
});

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
