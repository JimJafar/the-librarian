"use client";

// Surface-scoped keyboard handler. Wraps the duplicated "add a window
// keydown listener, skip when focus is in an input/textarea/
// contenteditable, skip when modifier keys are held" idiom used by
// every per-surface keyboard hook in the dashboard.
//
// The dashboard's keyboard contract has two layers — the global one in
// `keyboard-host.tsx` (⌘K palette, `?` overlay, g-prefix nav) and a
// per-surface one (vault: N / E / D / J / K / `/`, more to come on
// Phase 2 surfaces). They share the same skip rules; only the binding
// map differs. This hook centralises the shared bits so adding a new
// per-surface map on Memories / Handoffs / Proposals is one line and
// drift between surfaces can't sneak in.
//
// Usage:
//
//   useSurfaceShortcuts({
//     n: () => newFileTriggerRef.current?.click(),
//     e: () => setMode("edit"),
//     j: () => move(1),
//     k: () => move(-1),
//     "/": () => filterInputRef.current?.focus(),
//   });
//
// Keys are matched case-insensitively via `event.key.toLowerCase()`.
// Each handler runs with `event.preventDefault()` already called so a
// matched shortcut never falls through to a browser default. The hook
// is intentionally stateless — callers own refs, state, and routing.

import { useEffect, useRef } from "react";

export type SurfaceShortcuts = Record<string, (event: KeyboardEvent) => void>;

export function useSurfaceShortcuts(shortcuts: SurfaceShortcuts): void {
  // Callers typically pass a freshly-constructed object literal each
  // render. To keep the window listener stable (mount once, unmount on
  // unmount), the latest shortcut map is read off a ref that we refresh
  // on every render — the listener never needs re-binding.
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  useEffect(() => {
    function handler(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const map = shortcutsRef.current;
      const action = map[event.key.toLowerCase()] ?? map[event.key];
      if (!action) return;
      event.preventDefault();
      action(event);
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
