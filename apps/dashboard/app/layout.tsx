import type { Metadata, Viewport } from "next";
import { Fraunces, IBM_Plex_Mono, Newsreader } from "next/font/google";
import type { ReactNode } from "react";
import { auth } from "@/auth";
import { KeyboardHost } from "@/components/keyboard-host";
import { Providers } from "@/components/providers";
import { SiteNav } from "@/components/site-nav";
import { ThemeProvider } from "@/components/theme-provider";
import { isAuthEnforced } from "@/lib/auth-gate";
import "./globals.css";

// D1.0 — free fallback per the redesign spec (PP Editorial New /
// PP Neue Montreal are licensed and gated on a per-workstation
// purchase). IBM Plex Mono is free and lands the editorial-mono
// pairing for technical strings.
const fraunces = Fraunces({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
});
const newsreader = Newsreader({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-body",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Librarian Dashboard",
  description: "Admin dashboard for The Librarian — memories and handoffs.",
  // Favicon / PWA icon set lives in public/ (assets/icons/ holds the masters);
  // site.webmanifest references its PNGs by root path, served from public/.
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-48x48.png", sizes: "48x48", type: "image/png" },
    ],
    shortcut: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
  other: {
    "msapplication-TileColor": "#061B22",
    "msapplication-TileImage": "/mstile-150x150.png",
  },
};

// The browser-chrome theme colour, matching the manifest's theme_color.
export const viewport: Viewport = {
  themeColor: "#061B22",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const fontVars = `${fraunces.variable} ${newsreader.variable} ${plexMono.variable}`;
  // Only touch the session (and force dynamic rendering) when auth is enforced;
  // with the flag off the layout stays static and the nav shows no sign-out.
  const signedIn = isAuthEnforced() ? Boolean(await auth()) : false;
  return (
    <html lang="en" className={fontVars} suppressHydrationWarning>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem={false}
          disableTransitionOnChange
        >
          <Providers>
            {/* Brand watermark — a large, faint mark fixed behind all content.
                Decorative only: aria-hidden + pointer-events-none so it never
                intercepts clicks; -z-10 keeps it behind the page content while
                sitting above the body background. It's the light (dark-ink)
                variant, so it's a subtle ghost on the light theme and near-
                invisible on dark — fine for a watermark. */}
            <div
              aria-hidden
              className="pointer-events-none fixed inset-0 -z-10 flex items-center justify-center overflow-hidden"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- static SVG mark; next/image optimisation is N/A for vectors */}
              <img
                src="/the-librarian-mark-vector-light.svg"
                alt=""
                className="h-[85vh] w-auto opacity-[0.04]"
              />
            </div>
            <div className="flex min-h-screen flex-col">
              <SiteNav signedIn={signedIn} />
              {children}
            </div>
            <KeyboardHost />
          </Providers>
        </ThemeProvider>
      </body>
    </html>
  );
}
