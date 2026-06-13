import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyShellBlock,
  detectShell,
  readEnvFile,
  removeShellBlock,
  writeEnvFile,
} from "../src/env.js";
import { bashRcPath, envFilePath, fishConfPath, zshRcPath } from "../src/paths.js";
import { withTempHome } from "./helpers.js";

const SAMPLE = { mcpUrl: "https://mcp.example.com/mcp", token: "secret-agent-token-123" };

const BLOCK_OPEN = "# >>> librarian >>>";
const BLOCK_CLOSE = "# <<< librarian <<<";

function countBlocks(content: string): number {
  return content.split("\n").filter((line) => line.trim() === BLOCK_OPEN).length;
}

describe("env file", () => {
  it("writes both exports chmod 600", async () => {
    await withTempHome((home) => {
      writeEnvFile(SAMPLE, home);
      const file = envFilePath(home);
      const mode = fs.statSync(file).mode & 0o777;
      expect(mode).toBe(0o600);
      const text = fs.readFileSync(file, "utf8");
      expect(text).toContain("export LIBRARIAN_MCP_URL=");
      expect(text).toContain("export LIBRARIAN_AGENT_TOKEN=");
    });
  });

  it("round-trips values through read/write", async () => {
    await withTempHome((home) => {
      writeEnvFile(SAMPLE, home);
      expect(readEnvFile(home)).toEqual(SAMPLE);
    });
  });

  it("rewrites the file wholesale so stale values don't linger", async () => {
    await withTempHome((home) => {
      writeEnvFile(SAMPLE, home);
      writeEnvFile({ mcpUrl: "https://new.example.com/mcp", token: "new-token" }, home);
      const read = readEnvFile(home);
      expect(read?.mcpUrl).toBe("https://new.example.com/mcp");
      expect(read?.token).toBe("new-token");
      const text = fs.readFileSync(envFilePath(home), "utf8");
      expect(text).not.toContain("secret-agent-token-123");
    });
  });

  it("returns null when no env file exists", async () => {
    await withTempHome((home) => {
      expect(readEnvFile(home)).toBeNull();
    });
  });
});

describe("managed shell block (bash/zsh) idempotency", () => {
  for (const shell of ["bash", "zsh"] as const) {
    const rcPath = shell === "zsh" ? zshRcPath : bashRcPath;

    it(`${shell}: applying twice leaves exactly one block`, async () => {
      await withTempHome((home) => {
        applyShellBlock(shell, SAMPLE, home);
        applyShellBlock(shell, SAMPLE, home);
        const content = fs.readFileSync(rcPath(home), "utf8");
        expect(countBlocks(content)).toBe(1);
        expect(content).toContain('[ -f "$HOME/.librarian/env" ] && . "$HOME/.librarian/env"');
      });
    });

    it(`${shell}: preserves pre-existing rc content around the block`, async () => {
      await withTempHome((home) => {
        fs.writeFileSync(rcPath(home), "export FOO=bar\nalias ll='ls -la'\n");
        applyShellBlock(shell, SAMPLE, home);
        const content = fs.readFileSync(rcPath(home), "utf8");
        expect(content).toContain("export FOO=bar");
        expect(content).toContain("alias ll='ls -la'");
        expect(countBlocks(content)).toBe(1);
      });
    });

    it(`${shell}: re-apply after value change still leaves one block`, async () => {
      await withTempHome((home) => {
        applyShellBlock(shell, SAMPLE, home);
        applyShellBlock(shell, { mcpUrl: "https://x/mcp", token: "t2" }, home);
        const content = fs.readFileSync(rcPath(home), "utf8");
        expect(countBlocks(content)).toBe(1);
      });
    });

    it(`${shell}: removeShellBlock strips the block and leaves the rest`, async () => {
      await withTempHome((home) => {
        fs.writeFileSync(rcPath(home), "export FOO=bar\n");
        applyShellBlock(shell, SAMPLE, home);
        removeShellBlock(shell, home);
        const content = fs.readFileSync(rcPath(home), "utf8");
        expect(content).toContain("export FOO=bar");
        expect(countBlocks(content)).toBe(0);
        expect(content).not.toContain(BLOCK_CLOSE);
      });
    });
  }

  it("never writes the token into the bash/zsh rc", async () => {
    await withTempHome((home) => {
      applyShellBlock("bash", SAMPLE, home);
      const content = fs.readFileSync(bashRcPath(home), "utf8");
      expect(content).not.toContain(SAMPLE.token);
    });
  });
});

describe("fish native conf", () => {
  it("writes a conf.d file with set -gx, not a sourced POSIX block", async () => {
    await withTempHome((home) => {
      const written = applyShellBlock("fish", SAMPLE, home);
      expect(written).toBe(fishConfPath(home));
      const content = fs.readFileSync(fishConfPath(home), "utf8");
      expect(content).toContain("set -gx LIBRARIAN_MCP_URL");
      expect(content).toContain("set -gx LIBRARIAN_AGENT_TOKEN");
      expect(content).not.toContain('. "$HOME/.librarian/env"');
    });
  });

  it("re-applying overwrites the single conf file (idempotent)", async () => {
    await withTempHome((home) => {
      applyShellBlock("fish", SAMPLE, home);
      applyShellBlock("fish", { mcpUrl: "https://x/mcp", token: "t2" }, home);
      const content = fs.readFileSync(fishConfPath(home), "utf8");
      expect(countBlocks(content)).toBe(1);
      expect(content).toContain("https://x/mcp");
    });
  });

  it("removeShellBlock deletes the fish conf", async () => {
    await withTempHome((home) => {
      applyShellBlock("fish", SAMPLE, home);
      removeShellBlock("fish", home);
      expect(fs.existsSync(fishConfPath(home))).toBe(false);
    });
  });
});

describe("detectShell", () => {
  it("reads $SHELL", () => {
    expect(detectShell(undefined, { SHELL: "/usr/bin/zsh" })).toBe("zsh");
    expect(detectShell(undefined, { SHELL: "/usr/local/bin/fish" })).toBe("fish");
    expect(detectShell(undefined, { SHELL: "/bin/bash" })).toBe("bash");
  });

  it("override wins over $SHELL", () => {
    expect(detectShell("fish", { SHELL: "/bin/bash" })).toBe("fish");
  });

  it("falls back to bash for an unknown shell", () => {
    expect(detectShell(undefined, { SHELL: "/bin/ksh" })).toBe("bash");
    expect(detectShell(undefined, {})).toBe("bash");
  });
});
