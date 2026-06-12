import { describe, expect, it } from "vitest";
import { readConfig } from "../extensions/librarian/config.js";

describe("readConfig", () => {
  it("is dormant without endpoint + token", () => {
    expect(readConfig({})).toBeNull();
    expect(readConfig({ LIBRARIAN_MCP_URL: "https://x" })).toBeNull();
    expect(readConfig({ LIBRARIAN_AGENT_TOKEN: "t" })).toBeNull();
  });

  it("treats whitespace-only values as unset", () => {
    expect(readConfig({ LIBRARIAN_MCP_URL: "   ", LIBRARIAN_AGENT_TOKEN: "tok" })).toBeNull();
  });

  it("reads a configured environment", () => {
    const cfg = readConfig({
      LIBRARIAN_MCP_URL: "https://librarian.example/mcp",
      LIBRARIAN_AGENT_TOKEN: "tok",
      LIBRARIAN_TIMEOUT_MS: "9000",
    });
    expect(cfg).toMatchObject({
      endpoint: "https://librarian.example/mcp",
      token: "tok",
      timeoutMs: 9000,
    });
  });

  it("ignores a non-positive or non-numeric timeout", () => {
    const base = { LIBRARIAN_MCP_URL: "https://x", LIBRARIAN_AGENT_TOKEN: "t" };
    expect(readConfig({ ...base, LIBRARIAN_TIMEOUT_MS: "-5" })?.timeoutMs).toBeUndefined();
    expect(readConfig({ ...base, LIBRARIAN_TIMEOUT_MS: "soon" })?.timeoutMs).toBeUndefined();
  });
});
