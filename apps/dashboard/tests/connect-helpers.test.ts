import { describe, expect, it } from "vitest";
import {
  LIBRARIAN_SHORTCUT_ICLOUD_URL,
  isInsecureServerUrl,
  isInternalHost,
  resolveDisplayServerUrl,
  resolvePublicServerUrl,
} from "@/lib/connect";

describe("isInsecureServerUrl", () => {
  it("flags a plaintext http:// origin", () => {
    expect(isInsecureServerUrl("http://librarian.local:3838")).toBe(true);
    expect(isInsecureServerUrl("HTTP://Librarian.Local")).toBe(true);
    expect(isInsecureServerUrl("  http://example.com  ")).toBe(true);
  });

  it("does not flag https or an empty/unknown URL", () => {
    expect(isInsecureServerUrl("https://librarian.example.com")).toBe(false);
    expect(isInsecureServerUrl("")).toBe(false);
    expect(isInsecureServerUrl(null)).toBe(false);
    expect(isInsecureServerUrl(undefined)).toBe(false);
    // "https" must not be caught by an http prefix match.
    expect(isInsecureServerUrl("httpsfoo")).toBe(false);
  });
});

describe("resolvePublicServerUrl", () => {
  it("prefers PUBLIC_URL, then MCP_URL, then SERVER_URL", () => {
    expect(
      resolvePublicServerUrl({
        LIBRARIAN_PUBLIC_URL: "https://public",
        LIBRARIAN_MCP_URL: "https://mcp",
        LIBRARIAN_SERVER_URL: "https://server",
      }),
    ).toBe("https://public");
    expect(
      resolvePublicServerUrl({
        LIBRARIAN_MCP_URL: "https://mcp",
        LIBRARIAN_SERVER_URL: "https://server",
      }),
    ).toBe("https://mcp");
    expect(resolvePublicServerUrl({ LIBRARIAN_SERVER_URL: "https://server" })).toBe(
      "https://server",
    );
  });

  it("returns an empty string when nothing is configured", () => {
    expect(resolvePublicServerUrl({})).toBe("");
  });
});

describe("isInternalHost", () => {
  it("flags loopback / wildcard / bare single-label hosts", () => {
    for (const h of ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]", "mcp-server", ""]) {
      expect(isInternalHost(h)).toBe(true);
    }
  });
  it("does not flag a public hostname or IP", () => {
    for (const h of ["ssd-nodes.akita-betelgeuse.ts.net", "librarian.example.com", "203.0.113.7"]) {
      expect(isInternalHost(h)).toBe(false);
    }
  });
});

describe("resolveDisplayServerUrl", () => {
  it("swaps an internal host for the browser host but keeps the server port", () => {
    // The reported bug: dashboard knows the server as http://127.0.0.1:3838, but
    // the admin reached the dashboard at ssd-nodes…:3000 — the capture URL must be
    // the external host on the SERVER's port (3838), not the dashboard's.
    expect(
      resolveDisplayServerUrl("http://127.0.0.1:3838", {
        protocol: "http:",
        hostname: "ssd-nodes.akita-betelgeuse.ts.net",
      }),
    ).toBe("http://ssd-nodes.akita-betelgeuse.ts.net:3838");
  });

  it("handles the docker-compose internal service name", () => {
    expect(
      resolveDisplayServerUrl("http://mcp-server:3838", {
        protocol: "https:",
        hostname: "librarian.example.com",
      }),
    ).toBe("https://librarian.example.com:3838");
  });

  it("respects an already-external configured URL", () => {
    expect(
      resolveDisplayServerUrl("https://librarian.example.com", {
        protocol: "http:",
        hostname: "localhost",
      }),
    ).toBe("https://librarian.example.com");
  });

  it("falls back to the browser origin when nothing is configured", () => {
    expect(resolveDisplayServerUrl("", { protocol: "http:", hostname: "box.local" })).toBe(
      "http://box.local",
    );
  });
});

describe("LIBRARIAN_SHORTCUT_ICLOUD_URL", () => {
  it("points at the published iCloud Shortcut (SPIKE-B), not the placeholder", () => {
    // A published iCloud Shortcut link is /shortcuts/<32-hex-id> and carries no
    // secret (D17) — the install prompts for server URL + token locally.
    expect(LIBRARIAN_SHORTCUT_ICLOUD_URL).toMatch(
      /^https:\/\/www\.icloud\.com\/shortcuts\/[0-9a-f]{32}$/,
    );
    expect(LIBRARIAN_SHORTCUT_ICLOUD_URL).not.toContain("REPLACE_ME");
  });
});
