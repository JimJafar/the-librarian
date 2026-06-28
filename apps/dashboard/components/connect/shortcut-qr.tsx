"use client";

import QRCode from "react-qr-code";

// The iCloud Shortcut QR (reference-ingest D16/D17). Encodes the STATIC shortcut
// URL only — never a token or the server URL (the link carries no secret; the
// user pastes those into the Shortcut's import prompts on the phone). Rendered
// as crisp SVG modules, which suits the sharp-cornered editorial system.
//
// A QR must stay high-contrast dark-on-light to scan, so the tile is fixed warm
// paper with ink modules in BOTH themes rather than inverting in Scriptorium —
// a scannable code is the job here, theme parity is the wrapper's.
export function ShortcutQr({ url, label }: { url: string; label?: string }) {
  return (
    <figure className="m-0 inline-flex flex-col items-center gap-2">
      <div className="border border-ink-hairline bg-[#faf7f0] p-3">
        <QRCode
          value={url}
          size={132}
          bgColor="#faf7f0"
          fgColor="#1a1612"
          level="M"
          aria-label={label ?? "iCloud Shortcut QR code"}
        />
      </div>
      {label ? (
        <figcaption className="font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-foreground/60">
          {label}
        </figcaption>
      ) : null}
    </figure>
  );
}
