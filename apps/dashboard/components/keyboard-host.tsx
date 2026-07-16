// D1.4 — global keyboard handlers + command palette host.
//
// Mounted once in the root layout. Owns the cmd-k state, the `?`
// shortcuts overlay, and the data feeding the palette (recent
// memories + handoffs hydrated from tRPC, plus a static nav-target
// list). The palette + overlay are otherwise pure presentation —
// state lives here.

"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CommandPalette } from "@/components/ui-v2/command-palette";
import { JUMP_TARGETS, PALETTE_ITEMS, routeMatcher } from "@/lib/routes";
import { trpc } from "@/lib/trpc-client";

/** Window event name used by anything in the chrome (SiteNav `?`
 *  button today, future toolbar buttons / palette entries) that wants
 *  to open the shortcut overlay without owning its React state. The
 *  overlay state lives here; the rest of the app dispatches an event. */
export const OPEN_SHORTCUTS_EVENT = "librarian:open-shortcuts";

// The command-palette nav targets (`PALETTE_ITEMS`), the `g`-jump map
// (`JUMP_TARGETS`) and the per-surface shortcut predicates below all derive from
// the canonical route table in `@/lib/routes` (spec 063). The palette wants
// `id` / `hint`, the nav strip wants a `match` predicate — one source, shaped for
// each consumer. The shortcut *rows* ("New file", "Switch to Recall") are not
// route data and stay here; only their `surface` predicates come from the module.

// The two surfaces that carry contextual shortcuts. `onVaultSurface` matches the
// Vault tab's two-path rule (`/` and `/activity`) — which this file used to copy
// out of `TABS[0]` by hand.
const onVaultSurface = routeMatcher("/");
const onMemoriesSurface = routeMatcher("/memories");

// The shortcut sheet is contextual: globals (no `surface` predicate)
// always show; per-surface entries appear only when their predicate
// matches the current pathname. So the vault keys show on `/vault*`
// and stay out of the way on Memories / Handoffs / Settings, where
// they aren't bound. The bindings themselves still live with the
// surface they act on (vault-explorer + file-view); this list is the
// single source for the cheatsheet.
type Shortcut = {
  keys: string;
  description: string;
  surface?: (pathname: string) => boolean;
};

const SHORTCUTS: Shortcut[] = [
  { keys: "⌘K", description: "Open command palette" },
  { keys: "?", description: "Show this shortcut sheet" },
  { keys: "G V", description: "Go to Vault" },
  { keys: "G M", description: "Go to Memories" },
  { keys: "G H", description: "Go to Handoffs" },
  { keys: "Esc", description: "Close palette / overlay" },
  // Vault surface
  { keys: "N", description: "New file", surface: onVaultSurface },
  { keys: "E", description: "Edit current file", surface: onVaultSurface },
  { keys: "D", description: "Delete current file", surface: onVaultSurface },
  { keys: "J / K", description: "Next / previous file", surface: onVaultSurface },
  { keys: "/", description: "Filter the tree", surface: onVaultSurface },
  // Memories surface
  { keys: "N", description: "New memory", surface: onMemoriesSurface },
  { keys: "R", description: "Switch to Recall", surface: onMemoriesSurface },
  { keys: "/", description: "Focus the active input", surface: onMemoriesSurface },
  { keys: "J / K", description: "Next / previous memory", surface: onMemoriesSurface },
  { keys: "Esc", description: "Close inspector / clear recall", surface: onMemoriesSurface },
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
      ...PALETTE_ITEMS,
      ...mems.map((m) => ({
        id: `mem-${m.id}`,
        label: m.title || "(untitled memory)",
        detail: m.id,
        href: `/memories?selected=${m.id}`,
      })),
    ];
  }, [memoriesQuery.data]);

  const pathname = usePathname() ?? "";
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const openShortcuts = useCallback(() => setShortcutsOpen(true), []);

  // Chrome elements (the `?` button in SiteNav, future toolbar buttons)
  // open the sheet by dispatching a window event so they don't need to
  // share state with this component.
  useEffect(() => {
    const handler = () => setShortcutsOpen(true);
    window.addEventListener(OPEN_SHORTCUTS_EVENT, handler);
    return () => window.removeEventListener(OPEN_SHORTCUTS_EVENT, handler);
  }, []);

  // Cmd/Ctrl-K opens the palette; "?" opens the shortcuts overlay;
  // "g m" / "g h" navigate. The `g` prefix is auto-cancelling
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
        const target = JUMP_TARGETS[k];
        if (target) window.location.href = target;
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
      <ShortcutsOverlay
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        pathname={pathname}
      />
    </>
  );
}

function ShortcutsOverlay({
  open,
  onClose,
  pathname,
}: {
  open: boolean;
  onClose: () => void;
  pathname: string;
}) {
  useEffect(() => {
    if (!open) return;
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Globals always; per-surface entries only when their predicate
  // matches the current pathname.
  const visible = SHORTCUTS.filter((s) => !s.surface || s.surface(pathname));

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
          {visible.map((s) => (
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
