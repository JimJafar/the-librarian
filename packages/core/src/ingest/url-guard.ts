// SSRF guard for the `url`-capture fetch path (ingest spec Task 6; criterion 16;
// decision D23). A capture `url` is ATTACKER-INFLUENCED — a hostile page can
// redirect anywhere, a hostname can resolve to a private address, and a literal
// IP can be encoded in decimal/hex to dodge a naive string check. So we never
// trust the hostname string: we RESOLVE it and validate every resolved IP
// against a deny-list, then PIN the connection to exactly the validated address.
//
// This file is split into two layers so the dangerous classification logic can
// be unit-tested EXHAUSTIVELY without a network:
//   - `isBlockedAddress(ip)` — a PURE function over a numeric IP string. No DNS,
//     no sockets. Every deny-list range lives here.
//   - `createFetchGuard()` — the async wrapper that parses the URL, enforces the
//     http(s) scheme, resolves the host (via `dns.lookup`, which also normalizes
//     decimal/hex/octal literal IPs like `2130706433` → `127.0.0.1`), validates
//     EVERY resolved address with `isBlockedAddress`, and returns the address to
//     pin the socket to. A test can inject a relaxed guard (allowLoopback) so the
//     happy-path fetch pipeline can run against a 127.0.0.1 fixture server.

import dns from "node:dns/promises";
import net from "node:net";

/** The outcome of a passed guard check: the parsed URL plus the address to pin to. */
export interface FetchGuardResult {
  url: URL;
  /** The validated IP literal to pin the socket to (no DNS-rebinding re-resolve). */
  ip: string;
  /** The address family (4 | 6) for the pinned address. */
  family: number;
}

/** The injectable guard seam: production uses the real deny-list; a test can relax loopback. */
export interface FetchGuard {
  assertUrlFetchable(rawUrl: string): Promise<FetchGuardResult>;
}

/** Raised when a URL is refused before any connection is made (bad scheme / blocked IP / unresolvable). */
export class UrlNotFetchableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlNotFetchableError";
  }
}

/** Parse a strict dotted-quad IPv4 into its four octets, or null if it isn't one. */
function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets as [number, number, number, number];
}

/**
 * Classify an IPv4 (as octets) against the deny-list (D23): loopback `127/8`,
 * private `10/8` / `172.16/12` / `192.168/16`, link-local `169.254/16` (incl. the
 * cloud-metadata `169.254.169.254`), CGNAT `100.64/10`, `0.0.0.0/8`, broadcast,
 * and the non-public multicast/reserved space `224.0.0.0/3` (224–255).
 */
function isBlockedIpv4([a, b]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 ("this network")
  if (a === 10) return true; // private 10/8
  if (a === 127) return true; // loopback 127/8
  if (a === 169 && b === 254) return true; // link-local 169.254/16 (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16/12
  if (a === 192 && b === 168) return true; // private 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true; // multicast 224/4 + reserved 240/4 + broadcast 255.255.255.255
  return false;
}

/**
 * Expand a (net.isIPv6-validated) IPv6 string into its 8 numeric hextets,
 * handling `::` compression and an embedded IPv4 tail (`::ffff:a.b.c.d`). Returns
 * null if the input isn't a well-formed IPv6 literal.
 */
function parseIpv6(ip: string): number[] | null {
  if (!net.isIPv6(ip)) return null;
  let s = ip;
  const zone = s.indexOf("%"); // strip a scope id (fe80::1%eth0)
  if (zone >= 0) s = s.slice(0, zone);

  // Fold an embedded IPv4 tail into two hextets so the rest is pure hex groups.
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  let groups: string[];
  if (halves.length === 2) {
    const back = halves[1] ? halves[1].split(":") : [];
    const missing = 8 - head.length - back.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...back];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const hextets = groups.map((g) => parseInt(g || "0", 16));
  if (hextets.some((h) => Number.isNaN(h) || h < 0 || h > 0xffff)) return null;
  return hextets;
}

/** Extract the embedded IPv4 octets from an IPv4-mapped/compatible IPv6's last two hextets. */
function embeddedV4(h: number[]): [number, number, number, number] {
  const g6 = h[6] ?? 0;
  const g7 = h[7] ?? 0;
  return [(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff];
}

/**
 * Classify an IPv6 (as hextets) against the deny-list (D23): unspecified `::`,
 * loopback `::1`, ULA `fc00::/7`, link-local `fe80::/10`, multicast `ff00::/8`,
 * and — the key SSRF bypass — IPv4-mapped `::ffff:a.b.c.d` (and the deprecated
 * IPv4-compatible `::a.b.c.d`), whose embedded IPv4 is RE-CHECKED so a mapped
 * `::ffff:127.0.0.1` / `::ffff:169.254.169.254` is blocked.
 */
function isBlockedIpv6(h: number[]): boolean {
  const h0 = h[0] ?? 0;
  if (h.every((x) => x === 0)) return true; // :: unspecified
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1 loopback
  // IPv4-mapped (::ffff:v4) or IPv4-compatible (::v4): re-validate the embedded v4.
  if (
    h[0] === 0 &&
    h[1] === 0 &&
    h[2] === 0 &&
    h[3] === 0 &&
    h[4] === 0 &&
    (h[5] === 0xffff || h[5] === 0)
  ) {
    return isBlockedIpv4(embeddedV4(h));
  }
  if ((h0 & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((h0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((h0 & 0xff00) === 0xff00) return true; // multicast ff00::/8
  return false;
}

/**
 * PURE deny-list check over a numeric IP literal (IPv4 or IPv6). Returns true if
 * the address must NOT be connected to. Fails CLOSED: anything that doesn't parse
 * as an IP returns true (the guard only ever feeds it resolved numeric addresses,
 * so a non-IP here is an unexpected state we refuse rather than trust).
 */
export function isBlockedAddress(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return isBlockedIpv4(v4);
  const v6 = parseIpv6(ip);
  if (v6) return isBlockedIpv6(v6);
  return true;
}

/** Is this numeric IP a loopback address (127/8 or ::1, incl. IPv4-mapped loopback)? */
export function isLoopbackAddress(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return v4[0] === 127;
  const v6 = parseIpv6(ip);
  if (!v6) return false;
  if (v6.slice(0, 7).every((x) => x === 0) && v6[7] === 1) return true;
  if (
    v6[0] === 0 &&
    v6[1] === 0 &&
    v6[2] === 0 &&
    v6[3] === 0 &&
    v6[4] === 0 &&
    (v6[5] === 0xffff || v6[5] === 0)
  ) {
    return embeddedV4(v6)[0] === 127;
  }
  return false;
}

/** Pick the address to pin from a non-empty resolved list (first is fine; all were validated). */
function pinnedAddress(addresses: { address: string; family: number }[]): {
  address: string;
  family: number;
} {
  const first = addresses[0];
  if (!first) throw new UrlNotFetchableError("Refusing to fetch: host resolved to no addresses");
  return first;
}

/**
 * Build a fetch guard. Production uses the real deny-list; a test passes
 * `{ allowLoopback: true }` so the happy-path fetch pipeline can run against a
 * loopback fixture server while STILL blocking every other private range (so the
 * "redirect to a blocked IP is refused" test stays meaningful).
 */
export function createFetchGuard(opts: { allowLoopback?: boolean } = {}): FetchGuard {
  return {
    async assertUrlFetchable(rawUrl: string): Promise<FetchGuardResult> {
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        throw new UrlNotFetchableError("Refusing to fetch: not a valid URL");
      }
      // Scheme allow-list: only http(s). Rejects file:, ftp:, gopher:, data:, etc.
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new UrlNotFetchableError(`Refusing non-http(s) scheme: ${url.protocol}`);
      }

      // Resolve the host. `dns.lookup` normalizes decimal/hex/octal literal IPs
      // (e.g. http://2130706433/ → 127.0.0.1) via getaddrinfo, so an encoded
      // loopback/metadata literal is caught here even though `new URL` left the
      // host as the raw number. We strip IPv6 brackets for the resolver.
      const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
      let addresses: { address: string; family: number }[];
      try {
        addresses = await dns.lookup(hostname, { all: true });
      } catch {
        // Host is unresolvable — refuse rather than let the socket layer try.
        throw new UrlNotFetchableError(`Refusing to fetch: could not resolve host ${url.hostname}`);
      }
      if (addresses.length === 0) {
        throw new UrlNotFetchableError(
          `Refusing to fetch: host ${url.hostname} resolved to no addresses`,
        );
      }
      // Validate EVERY resolved address: if ANY is blocked, refuse the whole host
      // (a host that resolves to both a public and a private IP could be steered
      // to the private one by a rebinding resolver). The loopback exception is a
      // TEST-ONLY relaxation for the fixture server.
      for (const { address } of addresses) {
        if (opts.allowLoopback && isLoopbackAddress(address)) continue;
        if (isBlockedAddress(address)) {
          throw new UrlNotFetchableError(
            `Refusing to fetch a private/blocked address for host ${url.hostname}`,
          );
        }
      }
      // Pin to the first validated address. The fetch layer connects to EXACTLY
      // this IP (custom lookup), so there is no second resolution between check
      // and connect — no DNS-rebinding TOCTOU window.
      const pinned = pinnedAddress(addresses);
      return { url, ip: pinned.address, family: pinned.family };
    },
  };
}
