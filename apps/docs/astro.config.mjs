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
