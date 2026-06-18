"use client";

import { useEffect, useState } from "react";

/**
 * Track whether a CSS media query currently matches. SSR-safe: returns `false`
 * on the server and on the first client render, then syncs after mount.
 *
 * Use this to gate behaviour that a CSS `lg:hidden` class can't reach — most
 * notably portaled overlays (Radix Dialog/Popover render to `document.body`,
 * so a breakpoint class on a wrapper never touches the portaled nodes, and an
 * `open` dialog still traps focus even when visually hidden). Gate `open` on
 * the query instead.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
