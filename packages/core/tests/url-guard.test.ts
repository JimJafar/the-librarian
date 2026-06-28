// Exhaustive, network-free tests of the SSRF deny-list (ingest spec Task 6,
// criterion 16, D23). `isBlockedAddress` is a pure function over a numeric IP, so
// every range is asserted directly. The async guard is exercised only with
// LITERAL IPs (and the decimal/hex encodings that `dns.lookup` normalizes
// offline via getaddrinfo) so no real DNS/network is touched.

import { createFetchGuard, isBlockedAddress, isLoopbackAddress } from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("isBlockedAddress — IPv4 deny-list (criterion 16, D23)", () => {
  const blocked = [
    ["loopback 127/8", "127.0.0.1"],
    ["loopback 127/8 high", "127.255.255.254"],
    ["private 10/8", "10.0.0.1"],
    ["private 192.168/16", "192.168.1.1"],
    ["private 172.16/12 low", "172.16.5.5"],
    ["private 172.16/12 high", "172.31.255.255"],
    ["link-local 169.254/16", "169.254.1.1"],
    ["cloud metadata", "169.254.169.254"],
    ["CGNAT 100.64/10 low", "100.64.0.1"],
    ["CGNAT 100.64/10 high", "100.127.255.255"],
    ["this-network 0/8", "0.0.0.0"],
    ["broadcast", "255.255.255.255"],
    ["multicast 224/4", "224.0.0.1"],
  ] as const;
  for (const [name, ip] of blocked) {
    it(`blocks ${name} (${ip})`, () => {
      expect(isBlockedAddress(ip)).toBe(true);
    });
  }

  const allowed = [
    ["example.com", "93.184.216.34"],
    ["cloudflare dns", "1.1.1.1"],
    ["google dns", "8.8.8.8"],
    ["just outside 172.16/12", "172.15.0.1"],
    ["just outside 172.16/12 high", "172.32.0.1"],
    ["just outside CGNAT", "100.63.255.255"],
    ["just outside CGNAT high", "100.128.0.1"],
  ] as const;
  for (const [name, ip] of allowed) {
    it(`allows ${name} (${ip})`, () => {
      expect(isBlockedAddress(ip)).toBe(false);
    });
  }
});

describe("isBlockedAddress — IPv6 deny-list (criterion 16, D23)", () => {
  const blocked = [
    ["loopback ::1", "::1"],
    ["unspecified ::", "::"],
    ["link-local fe80::/10", "fe80::1"],
    ["ULA fc00::/7", "fc00::1"],
    ["ULA fd00 prefix", "fd12:3456::1"],
    ["multicast ff00::/8", "ff02::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped metadata", "::ffff:169.254.169.254"],
    ["IPv4-mapped private", "::ffff:10.0.0.1"],
  ] as const;
  for (const [name, ip] of blocked) {
    it(`blocks ${name} (${ip})`, () => {
      expect(isBlockedAddress(ip)).toBe(true);
    });
  }

  it("allows a public IPv6 address", () => {
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("allows an IPv4-mapped PUBLIC address (embedded v4 re-checked)", () => {
    expect(isBlockedAddress("::ffff:93.184.216.34")).toBe(false);
  });
});

describe("isBlockedAddress — fail-closed on non-IP input", () => {
  it("blocks a non-IP string", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
    expect(isBlockedAddress("999.999.999.999")).toBe(true);
  });
});

describe("isLoopbackAddress", () => {
  it("recognizes IPv4 + IPv6 loopback (incl. mapped)", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.9.9.9")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });
  it("does not flag a non-loopback private address as loopback", () => {
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackAddress("169.254.169.254")).toBe(false);
  });
});

describe("createFetchGuard — scheme + resolved-IP validation (D23)", () => {
  const guard = createFetchGuard();

  it("rejects a non-http(s) scheme", async () => {
    await expect(guard.assertUrlFetchable("file:///etc/passwd")).rejects.toThrow(/non-http/i);
    await expect(guard.assertUrlFetchable("ftp://example.com/x")).rejects.toThrow(/non-http/i);
    await expect(guard.assertUrlFetchable("gopher://example.com")).rejects.toThrow(/non-http/i);
  });

  it("rejects a literal loopback IP", async () => {
    await expect(guard.assertUrlFetchable("http://127.0.0.1/")).rejects.toThrow(/private|blocked/i);
  });

  it("rejects a DECIMAL-encoded loopback literal (2130706433 = 127.0.0.1)", async () => {
    await expect(guard.assertUrlFetchable("http://2130706433/")).rejects.toThrow(
      /private|blocked/i,
    );
  });

  it("rejects a HEX-encoded loopback literal (0x7f000001 = 127.0.0.1)", async () => {
    await expect(guard.assertUrlFetchable("http://0x7f000001/")).rejects.toThrow(
      /private|blocked/i,
    );
  });

  it("rejects the cloud-metadata literal", async () => {
    await expect(
      guard.assertUrlFetchable("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(/private|blocked/i);
  });

  it("rejects a private literal", async () => {
    await expect(guard.assertUrlFetchable("http://10.0.0.1/")).rejects.toThrow(/private|blocked/i);
  });

  it("never leaks credentials from the URL in the error", async () => {
    let message = "";
    try {
      await guard.assertUrlFetchable("http://user:s3cr3t@127.0.0.1/");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain("s3cr3t");
    expect(message).not.toContain("user:");
  });

  it("allows a public literal IP and pins to it", async () => {
    const result = await guard.assertUrlFetchable("http://93.184.216.34/path");
    expect(result.ip).toBe("93.184.216.34");
    expect(result.family).toBe(4);
    expect(result.url.protocol).toBe("http:");
  });

  it("loopback is allowed only when the test relaxation is set", async () => {
    const relaxed = createFetchGuard({ allowLoopback: true });
    const result = await relaxed.assertUrlFetchable("http://127.0.0.1:8080/x");
    expect(result.ip).toBe("127.0.0.1");
    // but the relaxation does NOT open other private ranges:
    await expect(relaxed.assertUrlFetchable("http://10.0.0.1/")).rejects.toThrow(
      /private|blocked/i,
    );
  });
});
