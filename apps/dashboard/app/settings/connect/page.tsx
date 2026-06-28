// "Connect a device" (reference-ingest spec criterion 14/21; D2/D16/D17/D18).
//
// The setup surface for the browser extension + mobile share. The operator mints
// a least-privilege CAPTURE token (it can only file references, never reach the
// agent memory tools), confirms the server URL the devices post to, and follows
// the per-client recipes. The iCloud Shortcut is offered as a link + QR; the
// link carries NO secret (the user pastes the server URL + token into the
// Shortcut's import prompts on the phone).

import { createCaptureTokenAction, revokeCaptureTokenAction } from "./actions";
import { CaptureTokenList } from "@/components/connect/capture-token-list";
import { MintCaptureToken } from "@/components/connect/mint-capture-token";
import { ServerUrlPanel } from "@/components/connect/server-url-panel";
import { ShortcutQr } from "@/components/connect/shortcut-qr";
import { SectionLabel } from "@/components/ui-v2/section-label";
import { LIBRARIAN_SHORTCUT_ICLOUD_URL, resolvePublicServerUrl } from "@/lib/connect";
import { serverTRPC } from "@/lib/trpc-server";

export const metadata = { title: "Connect a device · Librarian" };
export const dynamic = "force-dynamic";

export default async function ConnectPage() {
  const serverUrl = resolvePublicServerUrl();

  let captureTokens: { id: string; agentId: string; label: string; created_at: string }[] = [];
  let error: string | null = null;
  try {
    const all = await serverTRPC.tokens.list.query();
    captureTokens = all
      .filter((t) => t.scope === "capture")
      .map(({ id, agentId, label, created_at }) => ({ id, agentId, label, created_at }));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="flex flex-col gap-5 p-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-xl text-foreground">Connect a device</h1>
        <p className="max-w-[65ch] text-sm text-foreground/60">
          Set up the browser extension and your phone to send articles and clippings straight into
          the vault. Mint a capture token, confirm where your devices reach this server, then follow
          the recipe for each client.
        </p>
      </header>

      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          Failed to load capture tokens: {error}
        </p>
      ) : null}

      <MintCaptureToken onCreate={createCaptureTokenAction} />

      <ServerUrlPanel initialUrl={serverUrl} />

      <section
        className="border border-ink-hairline bg-ink-surface p-4"
        aria-label="iPhone &amp; iPad"
      >
        <h2 className="mb-1 font-display text-lg text-foreground">iPhone &amp; iPad</h2>
        <p className="mb-3 max-w-[60ch] text-sm text-foreground/70">
          Add the Librarian Shortcut, then share any page to it. Scan the code on your phone, or
          open the link. On first run the Shortcut asks for your server URL and capture token —
          paste the values from above; the link itself carries no secret.
        </p>
        <div className="flex flex-wrap items-start gap-6">
          <ShortcutQr url={LIBRARIAN_SHORTCUT_ICLOUD_URL} label="Scan to add the Shortcut" />
          <div className="flex flex-col gap-2 text-sm">
            <SectionLabel as="span">iCloud Shortcut</SectionLabel>
            <a
              href={LIBRARIAN_SHORTCUT_ICLOUD_URL}
              target="_blank"
              rel="noreferrer"
              className="break-all font-mono text-xs text-ink-accent underline underline-offset-2 hover:no-underline"
            >
              {LIBRARIAN_SHORTCUT_ICLOUD_URL}
            </a>
            <p className="max-w-[40ch] text-xs text-foreground/60">
              Placeholder link — the published Shortcut is pending. (TODO: SPIKE-B)
            </p>
          </div>
        </div>
      </section>

      <section
        className="border border-ink-hairline bg-ink-surface p-4"
        aria-label="Browser extension"
      >
        <h2 className="mb-1 font-display text-lg text-foreground">Browser extension</h2>
        <ol className="ml-4 flex max-w-[65ch] list-decimal flex-col gap-1.5 text-sm text-foreground/80">
          <li>
            Install the Librarian clipper from{" "}
            <code className="font-mono text-xs text-foreground/80">clients/chromium-extension</code>{" "}
            (load unpacked in your browser&rsquo;s extensions page).
          </li>
          <li>Open the extension&rsquo;s options.</li>
          <li>Paste the server URL and capture token from above.</li>
          <li>Click the clipper on any article to file it into the vault.</li>
        </ol>
      </section>

      <section className="border border-ink-hairline bg-ink-surface p-4" aria-label="Android">
        <h2 className="mb-1 font-display text-lg text-foreground">Android</h2>
        <p className="mb-2 max-w-[60ch] text-sm text-foreground/70">
          Use the <span className="font-medium">HTTP Shortcuts</span> app to add a share target:
        </p>
        <ol className="ml-4 flex max-w-[65ch] list-decimal flex-col gap-1.5 text-sm text-foreground/80">
          <li>
            New shortcut → method <code className="font-mono text-xs">POST</code> to{" "}
            <code className="font-mono text-xs">{serverUrl || "<server URL>"}/ingest</code>.
          </li>
          <li>
            Add header{" "}
            <code className="font-mono text-xs">Authorization: Bearer &lt;capture token&gt;</code>.
          </li>
          <li>Send the shared URL as the body, then enable &ldquo;use as share target.&rdquo;</li>
        </ol>
        <p className="mt-2 max-w-[60ch] text-xs text-foreground/60">
          A packaged recipe is coming; these steps work today.
        </p>
      </section>

      <section
        className="border border-ink-hairline bg-ink-surface p-4"
        aria-label="Capture tokens"
      >
        <h2 className="mb-3 font-display text-lg text-foreground">Capture tokens</h2>
        <CaptureTokenList tokens={captureTokens} onRevoke={revokeCaptureTokenAction} />
      </section>
    </main>
  );
}
