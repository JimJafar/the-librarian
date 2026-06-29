"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui-v2/button";
import { SectionLabel } from "@/components/ui-v2/section-label";
import { isInsecureServerUrl, resolveDisplayServerUrl } from "@/lib/connect";

// The address capture clients (browser extension / phone) POST to (D18). This is
// a DEPLOYMENT FACT, not a dashboard setting — the authoritative source is the
// server's LIBRARIAN_PUBLIC_URL env. So we DISPLAY it read-only + copyable rather
// than as an editable field, which would imply a server-changing edit it never
// was (editing here would only change what you copy, and not persist). The value
// is auto-detected: the server hands us its INTERNAL view (often loopback); on
// the client we swap in the host the admin actually reached this dashboard at,
// keeping the server port (see resolveDisplayServerUrl). When it's a plain http://
// origin we warn — the capture token rides in that request, so over http it
// crosses the wire in the clear, and a browser extension can only reach an http
// origin from its background worker, never a content script on an https page.
export function ServerUrlPanel({ initialUrl }: { initialUrl: string }) {
  const [url, setUrl] = useState(initialUrl);
  const [copied, setCopied] = useState(false);
  const insecure = isInsecureServerUrl(url);

  useEffect(() => {
    setUrl(resolveDisplayServerUrl(initialUrl, window.location));
  }, [initialUrl]);

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="border border-ink-hairline bg-ink-surface p-4" aria-label="Server URL">
      <h2 className="mb-1 font-display text-lg text-foreground">Server URL</h2>
      <p className="mb-3 max-w-[60ch] text-sm text-foreground/70">
        The address your devices send captures to — auto-detected from how you reached this page.
      </p>
      <div className="flex max-w-[40rem] flex-col gap-1.5">
        <SectionLabel as="span">Server URL</SectionLabel>
        <div className="flex items-center gap-2">
          <code
            className="flex-1 break-all border border-ink-hairline bg-ink-mono-fill px-3 py-2 font-mono text-sm text-foreground"
            aria-describedby={insecure ? "server-url-insecure" : undefined}
          >
            {url || "—"}
          </code>
          <Button type="button" variant="outline" onClick={copy} disabled={!url}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className="text-xs text-foreground/60">
          Wrong address? Set <code className="font-mono">LIBRARIAN_PUBLIC_URL</code> on the server
          to the URL your devices use — that&rsquo;s the persistent fix (this field is
          display-only).
        </p>
      </div>

      {insecure ? (
        <div
          id="server-url-insecure"
          role="alert"
          className="mt-3 max-w-[60ch] border border-destructive/50 bg-destructive/[0.06] p-3 text-sm text-foreground"
        >
          <p className="font-medium text-destructive">This is a plaintext http:// address.</p>
          <p className="mt-1 text-foreground/80">
            Your capture token is sent with every capture, so over{" "}
            <code className="font-mono">http</code> it travels unencrypted — anyone on the network
            can read it. The browser extension can only reach an{" "}
            <code className="font-mono">http</code> server from its background worker, never from a
            content script on an https page. Use <code className="font-mono">https</code> wherever
            you can.
          </p>
        </div>
      ) : null}
    </section>
  );
}
