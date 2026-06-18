// useMediaQuery — SSR-safe media-query hook used to gate portaled overlays
// (e.g. the /memories mobile bottom sheet must not open on desktop, where a
// `lg:hidden` wrapper can't reach the portaled Radix dialog).

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useMediaQuery } from "@/hooks/use-media-query";

/** Install a controllable matchMedia whose `matches` we can flip at will. */
function installMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<() => void>();
  const mql = {
    get matches() {
      return matches;
    },
    media: "",
    onchange: null,
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  };
  window.matchMedia = ((query: string) => {
    mql.media = query;
    return mql as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
  return {
    set(next: boolean) {
      matches = next;
      for (const cb of listeners) cb();
    },
  };
}

describe("useMediaQuery", () => {
  it("returns the initial match state", () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(true);
  });

  it("updates when the media query starts/stops matching", () => {
    const ctl = installMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(false);
    act(() => ctl.set(true));
    expect(result.current).toBe(true);
    act(() => ctl.set(false));
    expect(result.current).toBe(false);
  });
});
