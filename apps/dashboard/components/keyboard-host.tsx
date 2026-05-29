// D1.4 — global keyboard handlers + command palette host.
//
// Mounted once in the root layout. Owns the cmd-k state, the `?`
// shortcuts overlay, and the data feeding the palette (recent
// memories + handoffs hydrated from tRPC, plus a static nav-target
// list). The palette + overlay are otherwise pure presentation —
// state lives here.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CommandPalette } from "@/components/ui-v2/command-palette";
import { trpc } from "@/lib/trpc-client";

const NAV_ITEMS = [
  { id: "nav-memories", label: "Go to Memories", href: "/", hint: "G M" },
  { id: "nav-handoffs", label: "Go to Handoffs", href: "/handoffs", hint: "G H" },
  { id: "nav-recall", label: "Go to Recall", href: "/recall", hint: "G R" },
  { id: "nav-analytics", label: "Go to Analytics", href: "/analytics", hint: "" },
  { id: "nav-proposals", label: "Go to Proposals", href: "/proposals", hint: "" },
  { id: "nav-archive", label: "Go to Archive", href: "/archive", hint: "" },
  { id: "nav-logs", label: "Go to Logs", href: "/logs", hint: "" },
  { id: "nav-curator", label: "Go to Curator", href: "/curator", hint: "" },
  { id: "nav-classifier", label: "Go to Classifier", href: "/classifier", hint: "" },
  { id: "nav-backups", label: "Go to Backups", href: "/backups", hint: "" },
];

const SHORTCUTS: Array<{ keys: string; description: string }> = [
  { keys: "⌘K", description: "Open command palette" },
  { keys: "?", description: "Show this shortcut sheet" },
  { keys: "G M", description: "Go to Memories" },
  { keys: "G H", description: "Go to Handoffs" },
  { keys: "G R", description: "Go to Recall" },
  { keys: "Esc", description: "Close palette / overlay" },
];

export function KeyboardHost() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [goPrefix, setGoPrefix] = useState(false);

  // Hydrate the palette with a short list of memories by title.
  // The query is lightweight (the dashboard's bandwidth-conscious
  // defaults are fine here) and cached by react-query so opening
  // the palette twice doesn't re-fetch.
  const memoriesQuery = trpc.memories.list.useQuery(
    { limit: 25 } as Parameters<typeof trpc.memories.list.useQuery>[0],
    { enabled: paletteOpen },
  );

  const items = useMemo(() => {
    const mems = (memoriesQuery.data?.memories ?? []) as Array<{
      id: string;
      title?: string | null;
    }>;
    return [
      ...NAV_ITEMS,
      ...mems.map((m) => ({
        id: `mem-${m.id}`,
        label: m.title || "(untitled memory)",
        detail: m.id,
        href: `/?selected=${m.id}`,
      })),
    ];
  }, [memoriesQuery.data]);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const openShortcuts = useCallback(() => setShortcutsOpen(true), []);

  // Cmd/Ctrl-K opens the palette; "?" opens the shortcuts overlay;
  // "g m" / "g s" / "g r" navigate. The `g` prefix is auto-cancelling
  // after 1500ms so it doesn't trap the user.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inField =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openPalette();
        return;
      }

      // The two "global" non-modifier shortcuts only fire when no input
      // is focused — otherwise the user can't type a `?` into a search
      // box without triggering the overlay.
      if (inField) return;

      if (e.key === "?") {
        e.preventDefault();
        openShortcuts();
        return;
      }
      if (!goPrefix && e.key.toLowerCase() === "g") {
        setGoPrefix(true);
        setTimeout(() => setGoPrefix(false), 1500);
        return;
      }
      if (goPrefix) {
        const k = e.key.toLowerCase();
        setGoPrefix(false);
        if (k === "m") window.location.href = "/";
        else if (k === "h") window.location.href = "/handoffs";
        else if (k === "r") window.location.href = "/recall";
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [goPrefix, openPalette, openShortcuts]);

  return (
    <>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        items={items}
        query={query}
        onQueryChange={setQuery}
      />
      <ShortcutsOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </>
  );
}

function ShortcutsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4"
      onClick={onClose}
    >
      <div
        className="w-[min(420px,90vw)] border border-foreground/15 bg-background p-5 font-sans"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-lg text-foreground">Keyboard shortcuts</h2>
        <ul className="mt-3 grid gap-2">
          {SHORTCUTS.map((s) => (
            <li key={s.keys} className="flex items-center justify-between text-sm">
              <span className="text-foreground/80">{s.description}</span>
              <kbd className="border border-ink-accent/40 px-1.5 py-0.5 font-mono text-xs text-ink-accent">
                {s.keys}
              </kbd>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-foreground/60">Press Escape or click outside to close.</p>
      </div>
    </div>
  );
}
