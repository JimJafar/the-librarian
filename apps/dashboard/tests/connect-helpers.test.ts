import { describe, expect, it } from "vitest";
import {
  LIBRARIAN_SHORTCUT_ICLOUD_URL,
  isInsecureServerUrl,
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
