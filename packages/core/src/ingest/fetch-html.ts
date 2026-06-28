// SSRF-safe HTML fetcher for the `url`-capture path (ingest spec Task 6;
// criteria 16/17/18; decision D23). Wraps node:http / node:https `request` so we
// control every hop:
//
//   - PIN the socket to the guard-validated IP via a custom `lookup` that ignores
//     the hostname and always returns the pre-validated address. This closes the
//     DNS-rebinding TOCTOU window: the address the guard checked IS the address
//     the socket connects to. TLS SNI + the Host header still use the real
//     hostname (request(url, …) sets servername from url.hostname), so virtual
//     hosting / cert validation are unaffected.
//   - MANUAL redirect handling (not redirect:"error", which would break the
//     legitimate http→https / canonical redirects of the mobile path — criterion
//     18): on a 3xx we resolve Location and loop, re-running the guard on the next
//     hop, up to a small cap. Every hop is re-validated.
//   - BODY-SIZE cap: stream and abort once the response exceeds the cap so a
//     hostile huge body can't OOM the process. `accept-encoding: identity` avoids
//     a compressed body decompressing past the cap (decompression bomb).
//   - CONTENT-TYPE gate: only `text/html` is extracted; anything else (PDF, JSON,
//     binary) is a failure, not an extraction attempt.
//   - TIMEOUT on the request.
//
// NO Authorization header is ever sent to a fetched URL (the capture token is for
// OUR endpoint, never forwarded to an arbitrary third-party origin).

import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import type { FetchGuard } from "./url-guard.js";

/** A successfully fetched HTML document plus the final (post-redirect) URL. */
export interface FetchedHtml {
  html: string;
  finalUrl: string;
}

/** Raised for any fetch-layer refusal: non-2xx, non-HTML, oversize body, timeout, too many redirects. */
export class HtmlFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HtmlFetchError";
  }
}

export interface FetchHtmlOptions {
  /** The SSRF guard — validates+pins each hop. Injected so a test can relax loopback. */
  guard: FetchGuard;
  /** Max response body bytes before the stream is aborted (default ~10 MB). */
  maxBodyBytes?: number;
  /** Per-request timeout in ms (default 15 s). */
  timeoutMs?: number;
  /** Max redirect hops to follow (default 5). */
  maxRedirects?: number;
}

const DEFAULT_MAX_BODY = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;

type SingleHop = { kind: "redirect"; location: string } | { kind: "ok"; body: string };

/**
 * Fetch an HTML document with SSRF protection. Re-validates and re-pins on every
 * redirect hop. Throws {@link HtmlFetchError} (or the guard's
 * `UrlNotFetchableError`) on any refusal — the caller logs it as a failed attempt
 * and writes nothing.
 */
export async function fetchHtml(rawUrl: string, opts: FetchHtmlOptions): Promise<FetchedHtml> {
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    // Re-validate + re-pin THIS hop's URL before connecting (criterion 16).
    const { url, ip, family } = await opts.guard.assertUrlFetchable(currentUrl);
    const result = await requestOnce(url, ip, family, { maxBody, timeoutMs });
    if (result.kind === "ok") {
      return { html: result.body, finalUrl: url.toString() };
    }
    // A 3xx: resolve Location against the current URL and loop (the next
    // iteration re-runs the guard on it). Reject once we exceed the hop cap.
    if (hop === maxRedirects) {
      throw new HtmlFetchError(`Too many redirects (cap ${maxRedirects})`);
    }
    let next: URL;
    try {
      next = new URL(result.location, url);
    } catch {
      throw new HtmlFetchError("Refusing to follow an invalid redirect Location");
    }
    currentUrl = next.toString();
  }
  // Unreachable (the loop returns or throws), but satisfies the type checker.
  throw new HtmlFetchError(`Too many redirects (cap ${maxRedirects})`);
}

/** Issue one request to the pinned IP and classify the response (redirect | ok). */
function requestOnce(
  url: URL,
  ip: string,
  family: number,
  o: { maxBody: number; timeoutMs: number },
): Promise<SingleHop> {
  return new Promise<SingleHop>((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;

    // PIN: ignore the hostname; always hand the socket the pre-validated IP.
    const lookup: LookupFunction = ((hostname, options, callback) => {
      const cb = callback as (
        err: NodeJS.ErrnoException | null,
        address: string | { address: string; family: number }[],
        family?: number,
      ) => void;
      if (typeof options === "object" && options?.all) {
        cb(null, [{ address: ip, family }]);
      } else {
        cb(null, ip, family);
      }
    }) as LookupFunction;

    const req = transport.request(
      url,
      {
        method: "GET",
        lookup,
        headers: {
          // Deliberately NO Authorization: never forward our capture credential
          // to an arbitrary third-party origin.
          accept: "text/html,application/xhtml+xml",
          "user-agent": "Librarian-Ingest/1.0 (+https://github.com/JimJafar/the-librarian)",
          // identity encoding so the body-size cap measures real bytes and a
          // compressed bomb can't expand past it.
          "accept-encoding": "identity",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;

        // Redirect: hand the Location back to the loop (which re-validates it).
        if (status >= 300 && status < 400 && typeof location === "string" && location) {
          res.resume(); // drain so the socket can be reused/closed cleanly
          resolve({ kind: "redirect", location });
          return;
        }
        // Anything not a clean 2xx is a failed attempt (criterion 18).
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new HtmlFetchError(`Upstream returned HTTP ${status}`));
          return;
        }
        // Content-Type gate (criterion 17): only text/html is extracted.
        const contentType = String(res.headers["content-type"] ?? "").trim();
        if (!/^text\/html(\s*;|\s*$)/i.test(contentType)) {
          res.resume();
          reject(new HtmlFetchError(`Refusing non-HTML content-type: ${contentType || "(none)"}`));
          return;
        }

        // Stream with a hard body-size cap (criterion 17).
        let size = 0;
        const chunks: Buffer[] = [];
        let settled = false;
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          size += chunk.length;
          if (size > o.maxBody) {
            settled = true;
            req.destroy();
            res.destroy();
            reject(new HtmlFetchError(`Response body exceeded the ${o.maxBody}-byte cap`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({ kind: "ok", body: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", (err) => {
          if (settled) return;
          settled = true;
          reject(new HtmlFetchError(`Response stream error: ${err.message}`));
        });
      },
    );

    req.on("error", (err) => reject(new HtmlFetchError(`Fetch failed: ${err.message}`)));
    req.setTimeout(o.timeoutMs, () => {
      req.destroy();
      reject(new HtmlFetchError(`Fetch timed out after ${o.timeoutMs}ms`));
    });
    req.end();
  });
}
