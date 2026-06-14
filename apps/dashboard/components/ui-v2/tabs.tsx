// U1 — editorial Tabs wrapper around Radix Tabs.
//
// Vermilion / saffron underline on the active tab (theme picks which),
// hairline separator beneath the tab strip, mono labels for the verb
// shape we use most. API mirrors Radix so the legacy shadcn wrapper
// can be swapped 1:1.

"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import { forwardRef, type ComponentPropsWithoutRef } from "react";

const Tabs = TabsPrimitive.Root;

const TabsList = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof TabsPrimitive.List>>(
  function TabsList({ className = "", ...props }, ref) {
    return (
      <TabsPrimitive.List
        ref={ref}
        className={`inline-flex items-end gap-4 border-b border-ink-hairline ${className}`.trim()}
        {...props}
      />
    );
  },
);

const TabsTrigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className = "", ...props }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={`-mb-px inline-flex h-9 items-center border-b-2 border-transparent px-1 text-sm font-medium text-foreground/60 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent disabled:cursor-not-allowed disabled:opacity-50 data-[state=active]:border-ink-accent data-[state=active]:text-foreground pointer-coarse:h-11 pointer-coarse:px-3 pointer-coarse:text-base ${className}`.trim()}
      {...props}
    />
  );
});

const TabsContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className = "", ...props }, ref) {
  return (
    <TabsPrimitive.Content
      ref={ref}
      className={`pt-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent ${className}`.trim()}
      {...props}
    />
  );
});

export { Tabs, TabsList, TabsTrigger, TabsContent };
