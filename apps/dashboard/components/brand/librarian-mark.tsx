"use client";

// The librarian mark — the brand figure rendered as a real graphic
// element in the layout, not the failed-watermark we used to do.
//
// Two source SVGs (`/brand/librarian-mark-light.svg` and `-teal.svg`)
// live in public/. Each is a fully-painted illustration, *not* a
// currentColor-style monochrome — the light one is a multi-tone taupe-
// and-gold painting, the teal one a posterized cool composition. We
// theme-swap rather than tint, because the references commit to two
// distinct paintings (the "warm objects in a cool room" reading the
// dark theme leans on isn't a colour-shift, it's a recomposition).
//
// Sizes the layout actually asks for:
//   - "sidebar" (default): 56px tall mark next to the page heading
//   - "hero": 280–360px on empty / landing surfaces
//   - "loading": 24–32px paired with MemoryOrb's pulse
//
// During hydration `useTheme()` resolves to undefined; we render the
// light variant + suppressHydrationWarning so the swap to dark is a
// quiet repaint, not a flash + DOM swap that flickers the layout.

import Image from "next/image";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

type Size = "sidebar" | "hero" | "loading";

const SIZES: Record<Size, { width: number; height: number; className: string }> = {
  // The source SVG viewBox is 767×1116 — ~0.687 aspect (tall portrait).
  // Heights below match the role; widths derive from that ratio.
  sidebar: { width: 38, height: 56, className: "shrink-0" },
  hero: { width: 220, height: 320, className: "shrink-0" },
  loading: { width: 22, height: 32, className: "shrink-0" },
};

export function LibrarianMark({
  size = "sidebar",
  className = "",
}: {
  size?: Size;
  className?: string;
}) {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const variant = mounted && resolvedTheme === "dark" ? "teal" : "light";
  const dims = SIZES[size];

  return (
    <Image
      src={`/brand/librarian-mark-${variant}.svg`}
      alt="" /* decorative — the surrounding heading carries the page name */
      role="presentation"
      width={dims.width}
      height={dims.height}
      priority={size === "sidebar"}
      className={`${dims.className} ${className}`.trim()}
      suppressHydrationWarning
    />
  );
}
