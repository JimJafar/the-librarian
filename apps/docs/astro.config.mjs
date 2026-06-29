// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// Astro defaults to a static build; the docs site is plain static HTML served
// by Cloudflare Pages (spec K2), so the output is pinned explicitly.
// https://docs.astro.build/en/reference/configuration-reference/
export default defineConfig({
  output: "static",
  integrations: [
    starlight({
      title: "The Librarian",
      description:
        "Operating guide for The Librarian — a portable memory + handoff layer for AI agents.",
      customCss: [
        // The three-face editorial system (Fontsource), loaded before the
        // skin so the `--sl-font` overrides can reference the families.
        "@fontsource/fraunces/400.css",
        "@fontsource/fraunces/500.css",
        "@fontsource/newsreader/400.css",
        "@fontsource/newsreader/500.css",
        "@fontsource/ibm-plex-mono/400.css",
        "@fontsource/ibm-plex-mono/500.css",
        // The Reading Room palette + typography (`--sl-*` overrides).
        "./src/styles/reading-room.css",
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/JimJafar/the-librarian",
        },
      ],
      sidebar: [
        {
          label: "Start here",
          items: [{ slug: "start-here/what-is-the-librarian" }, { slug: "start-here/install" }],
        },
      ],
    }),
  ],
});
