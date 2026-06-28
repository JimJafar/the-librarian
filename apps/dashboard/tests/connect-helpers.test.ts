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
  it("is a placeholder pending SPIKE-B (carries no secret)", () => {
    expect(LIBRARIAN_SHORTCUT_ICLOUD_URL).toContain("icloud.com/shortcuts/");
    expect(LIBRARIAN_SHORTCUT_ICLOUD_URL).toContain("REPLACE_ME");
  });
});
