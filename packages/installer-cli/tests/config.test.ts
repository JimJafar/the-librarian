import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { deriveServerUrl, formatConfig, readConfig, redact, setConfig } from "../src/config.js";
import { envFilePath } from "../src/paths.js";
import { withTempHome } from "./helpers.js";

const TOKEN = "super-secret-token-value";

describe("config", () => {
  it("derives the server url from the MCP url origin", () => {
    expect(deriveServerUrl("https://mcp.example.com:8443/mcp")).toBe(
      "https://mcp.example.com:8443",
    );
    expect(deriveServerUrl("")).toBe("");
    expect(deriveServerUrl("not a url")).toBe("");
  });

  it("setConfig persists to ~/.librarian/env and reads back", async () => {
    await withTempHome((home) => {
      const cfg = setConfig(
        { mcpUrl: "https://mcp.example.com/mcp", token: TOKEN },
        { home, shell: "bash" },
      );
      expect(cfg.serverUrl).toBe("https://mcp.example.com");
      const read = readConfig(home);
      expect(read?.mcpUrl).toBe("https://mcp.example.com/mcp");
      expect(read?.token).toBe(TOKEN);
    });
  });

  it("merges: setting only the token keeps the url", async () => {
    await withTempHome((home) => {
      setConfig({ mcpUrl: "https://mcp.example.com/mcp" }, { home, shell: "bash" });
      setConfig({ token: TOKEN }, { home, shell: "bash" });
      const read = readConfig(home);
      expect(read?.mcpUrl).toBe("https://mcp.example.com/mcp");
      expect(read?.token).toBe(TOKEN);
    });
  });

  it("redact reduces the token to a boolean and never exposes it", async () => {
    await withTempHome((home) => {
      const cfg = setConfig(
        { mcpUrl: "https://mcp.example.com/mcp", token: TOKEN },
        { home, shell: "bash" },
      );
      const redacted = redact(cfg);
      expect(redacted).not.toHaveProperty("token");
      expect(redacted.tokenSet).toBe(true);
      expect(JSON.stringify(redacted)).not.toContain(TOKEN);
    });
  });

  it("formatConfig never prints the token value", async () => {
    await withTempHome((home) => {
      const cfg = setConfig(
        { mcpUrl: "https://mcp.example.com/mcp", token: TOKEN },
        { home, shell: "bash" },
      );
      const out = formatConfig(redact(cfg));
      expect(out).not.toContain(TOKEN);
      expect(out).toContain("set (hidden)");
    });
  });

  it("readConfig returns null before anything is set", async () => {
    await withTempHome((home) => {
      expect(readConfig(home)).toBeNull();
    });
  });

  it("the persisted env file is chmod 600", async () => {
    await withTempHome((home) => {
      setConfig({ mcpUrl: "https://x/mcp", token: TOKEN }, { home, shell: "bash" });
      const mode = fs.statSync(envFilePath(home)).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });
});
