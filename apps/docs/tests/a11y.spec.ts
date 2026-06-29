import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Every public route in the site. Each is checked under BOTH Reading Room
// palettes (Manuscript / Scriptorium) because the warm-paper + verdigris
// combination is the easy WCAG miss (DESIGN.md), and the spec requires the
// contrast of the custom `--sl-*` overrides to be verified, not assumed.
const ROUTES = [
  "/",
  "/start-here/what-is-the-librarian/",
  "/start-here/install/",
  "/start-here/first-run/",
  "/connect/claude-code/",
  "/connect/codex/",
  "/connect/opencode/",
  "/connect/hermes/",
  "/connect/pi/",
  "/dashboard/",
  "/dashboard/memories/",
  "/dashboard/proposals/",
  "/dashboard/flagged/",
  "/dashboard/archive/",
  "/dashboard/analytics/",
  "/dashboard/handoffs/",
  "/dashboard/curator/",
  "/dashboard/vault/",
  "/dashboard/activity/",
  "/dashboard/health/",
  "/dashboard/settings/",
  "/guides/reviewing-proposals/",
  "/guides/handoff-takeover/",
  "/guides/private-mode/",
  "/guides/backups-restore/",
  "/guides/configuring-the-curator/",
  "/deploy-and-operate/self-host/",
  "/deploy-and-operate/manual-install/",
  "/deploy-and-operate/auth-and-secrets/",
];
const THEMES = ["light", "dark"] as const;

// WCAG 2.1 Level AA — the product's own accessibility bar (PRODUCT.md).
const WCAG_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

for (const route of ROUTES) {
  for (const theme of THEMES) {
    test(`${route} meets WCAG 2.1 AA in ${theme} mode`, async ({ page }) => {
      await page.goto(route);
      // Force the palette deterministically rather than relying on the OS
      // preference or a click, so axe scans the exact theme under test.
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);

      const results = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();

      // Surface a readable summary on failure instead of a giant object dump.
      const summary = results.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          data: [...n.any, ...n.none].map((c) => c.data),
        })),
      }));
      expect(summary, JSON.stringify(summary, null, 2)).toEqual([]);
    });
  }
}
