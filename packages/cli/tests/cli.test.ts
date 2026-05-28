// CLI runtime tests.
//
// sessions-rethink PR 7 — the sessions verb family is retired. What's
// left at the CLI level is `rebuild`, `seed`, top-level commands like
// `backup`/`restore`/`export`, the `handoffs` subcommands (covered in
// handoffs-cli.test.ts), and `auth`.

import { describe, expect, it } from "vitest";
import { withStore } from "../../../test/helpers.js";
import { runCli } from "../src/runtime.js";

describe("CLI runtime", () => {
  it("prints help for an unknown command", async () => {
    await withStore(async (store) => {
      const result = runCli(["help"], store);
      expect(result.stdout).toMatch(/Usage:/i);
    });
  });

  it("rebuild still works after the subcommand refactor", async () => {
    await withStore(async (store) => {
      const result = runCli(["rebuild"], store);
      expect(result.stdout).toMatch(/[Rr]ebuilt/);
      expect(result.exitCode).toBe(0);
    });
  });

  it("seed attributes its bootstrap memories to the system-migration actor", async () => {
    await withStore(async (store) => {
      const result = runCli(["seed"], store);
      expect(result.exitCode).toBe(0);
      const agents = store.distinctValues({ field: "agent_id" });
      expect(agents).toContain("system-migration");
      expect(agents).not.toContain("system");
    });
  });

  it("an unknown top-level command exits non-zero with the usage screen", async () => {
    await withStore(async (store) => {
      const result = runCli(["no-such-command"], store);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toMatch(/Unknown command: no-such-command/);
      expect(result.stdout).toMatch(/Usage: the-librarian/);
    });
  });

  it("an unknown handoffs verb prints the handoffs usage", async () => {
    await withStore(async (store) => {
      const result = runCli(["handoffs", "no-such-verb"], store);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toMatch(/Unknown handoffs verb: no-such-verb/);
      expect(result.stdout).toContain("Usage: the-librarian handoffs");
    });
  });
});
