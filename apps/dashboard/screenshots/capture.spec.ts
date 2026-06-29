import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { seedScreenshotData } from "./seed";

// Screenshot runner (docs-site spec T3.2–T3.4). Drives the live, seeded
// dashboard and emits one deterministic PNG per documented route into the docs
// site's assets. Each capture is a test: an empty or failed capture fails the
// job (criterion #7). Secrets are defensively masked before every capture
// (criterion #9) — the tour routes below are deliberately non-secret, but the
// mask is applied unconditionally so a future secret-bearing route can't leak.

const OUT_DIR = path.resolve(process.cwd(), "../docs/src/assets/screenshots");

// slug → docs page (apps/docs/.../dashboard/<slug>.md) ; url → dashboard route.
// The Settings tour page documents all tabs; we capture the non-secret Auth tab
// as its representative. The secret-bearing Tokens / Connect tabs are NOT
// captured.
const ROUTES = [
  { slug: "vault", url: "/" },
  { slug: "memories", url: "/memories" },
  { slug: "proposals", url: "/proposals" },
  { slug: "flagged", url: "/flagged" },
  { slug: "archive", url: "/archive" },
  { slug: "analytics", url: "/analytics" },
  { slug: "handoffs", url: "/handoffs" },
  { slug: "curator", url: "/curator" },
  { slug: "activity", url: "/activity" },
  { slug: "health", url: "/health" },
  { slug: "settings", url: "/settings/auth" },
] as const;

// Regions that can render a bearer token / capture token / pairing QR. Redacted
// (text blanked + blurred) before capture so no secret can reach a committed
// image. Sources: components/tokens/generate-form.tsx,
// components/connect/mint-capture-token.tsx, components/connect/shortcut-qr.tsx.
const SECRET_SELECTORS = ['div[role="status"] code', 'svg[aria-label*="QR" i]', "[data-secret]"];

test.beforeAll(() => {
  seedScreenshotData();
});

for (const route of ROUTES) {
  test(`capture ${route.slug}`, async ({ page }) => {
    // Determinism: force the light Reading Room palette and suppress motion.
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(route.url, { waitUntil: "domcontentloaded" });

    // Determinism: kill animations/transitions/carets, then wait for fonts and
    // a short settle so SSR content + hydration have painted. (networkidle is
    // avoided — the live dashboard keeps connections open and would flake.)
    await page.addStyleTag({
      content:
        "*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}",
    });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1200);

    // Defensive secret masking (no-op on the non-secret tour routes).
    for (const selector of SECRET_SELECTORS) {
      for (const handle of await page.locator(selector).all()) {
        await handle.evaluate((node) => {
          node.textContent = "•••••••••  redacted  •••••••••";
          (node as HTMLElement).style.filter = "blur(6px)";
        });
      }
    }

    const buffer = await page.screenshot({ fullPage: true });
    expect(buffer.byteLength, `${route.slug} produced an empty capture`).toBeGreaterThan(3000);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, `${route.slug}.png`), buffer);
  });
}
