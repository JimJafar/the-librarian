import type { Metadata } from "next";
import { Fraunces, IBM_Plex_Mono, Newsreader } from "next/font/google";
import type { ReactNode } from "react";
import { KeyboardHost } from "@/components/keyboard-host";
import { Providers } from "@/components/providers";
import { SiteNav } from "@/components/site-nav";
import { ThemeProvider } from "@/components/theme-provider";
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
  description: "Admin dashboard for The Librarian — memories and sessions.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const fontVars = `${fraunces.variable} ${newsreader.variable} ${plexMono.variable}`;
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
            <div className="flex min-h-screen flex-col">
              <SiteNav />
              {children}
            </div>
            <KeyboardHost />
          </Providers>
        </ThemeProvider>
      </body>
    </html>
  );
}
