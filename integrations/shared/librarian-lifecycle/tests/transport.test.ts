import { describe, expect, it } from "vitest";
import { createLibrarianCliForEnv, shouldUseRemote } from "../src/transport.js";

describe("shouldUseRemote", () => {
  it("is true when LIBRARIAN_MCP_URL is set", () => {
    expect(shouldUseRemote({ LIBRARIAN_MCP_URL: "https://lib.example/mcp" })).toBe(true);
  });

  it("is false when LIBRARIAN_MCP_URL is unset", () => {
    expect(shouldUseRemote({})).toBe(false);
  });

  it("is false for an empty or whitespace-only value", () => {
    expect(shouldUseRemote({ LIBRARIAN_MCP_URL: "" })).toBe(false);
    expect(shouldUseRemote({ LIBRARIAN_MCP_URL: "   " })).toBe(false);
  });
});

describe("createLibrarianCliForEnv", () => {
  it("returns a full LibrarianCli for the local transport", () => {
    const cli = createLibrarianCliForEnv({ harness: "claude-code", agent: "a", env: {} });
    expect(typeof cli.startSession).toBe("function");
    expect(typeof cli.listSessions).toBe("function");
    expect(typeof cli.continueSession).toBe("function");
    expect(typeof cli.checkpointSession).toBe("function");
    expect(typeof cli.pauseSession).toBe("function");
    expect(typeof cli.endSession).toBe("function");
  });

  it("returns a full LibrarianCli for the remote transport", () => {
    const cli = createLibrarianCliForEnv({
      harness: "claude-code",
      agent: "a",
      env: { LIBRARIAN_MCP_URL: "https://lib.example/mcp", LIBRARIAN_AGENT_TOKEN: "t" },
    });
    expect(typeof cli.startSession).toBe("function");
    expect(typeof cli.endSession).toBe("function");
  });
});
