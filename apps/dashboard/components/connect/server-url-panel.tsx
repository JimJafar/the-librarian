"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";
import { SectionLabel } from "@/components/ui-v2/section-label";
import { isInsecureServerUrl, resolveDisplayServerUrl } from "@/lib/connect";

// The server URL the capture clients POST to (D18). Pre-filled from the env the
// dashboard knows; the operator confirms or corrects it. When the URL is plain
// `http://` we warn prominently — the capture token travels in that request, so
// http means it crosses the wire in the clear, and the browser extension can
// only reach an http origin from its background service worker (a content
// script on an https page is blocked from making the insecure request).
export function ServerUrlPanel({ initialUrl }: { initialUrl: string }) {
  const [url, setUrl] = useState(initialUrl);
  const [copied, setCopied] = useState(false);
  const insecure = isInsecureServerUrl(url);

  // `initialUrl` is the server's INTERNAL view of the mcp-server (often a loopback
  // host like 127.0.0.1:3838, ADR 0001). On the client we know the host the admin
  // actually reached this dashboard at — swap it in (keeping the server port) so
  // the displayed URL is one the extension/phone can actually post to. Runs once
  // on mount; the operator can still edit. Only overrides an internal/empty value.
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
        The address your devices send captures to. Confirm it matches how the extension and your
        phone reach this server.
      </p>
      <label className="flex max-w-[40rem] flex-col gap-1.5">
        <SectionLabel as="span">Server URL</SectionLabel>
        <div className="flex items-end gap-2">
          <Input
            variant="mono"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setCopied(false);
            }}
            placeholder="https://librarian.example.com"
            inputMode="url"
            aria-describedby={insecure ? "server-url-insecure" : undefined}
          />
          <Button type="button" variant="outline" onClick={copy} disabled={!url}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </label>

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
