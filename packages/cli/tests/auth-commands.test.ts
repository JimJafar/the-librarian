import {
  type LibrarianStore,
  authenticateOwner,
  consumeSetupLink,
  getAuthStatus,
  getLockoutState,
  setEnabled,
  setOwnerPassword,
  verifyOwnerPassword,
} from "@librarian/core";
import { describe, expect, it } from "vitest";
import { withStore } from "../../../test/helpers.js";
import { resetPasswordCommand } from "../src/commands/auth.js";
import { runCli } from "../src/runtime.js";

const STRONG = "new-strong-password";

describe("the-librarian auth (D4)", () => {
  it("status reports a fresh, unconfigured store", async () => {
    await withStore(async (store: LibrarianStore) => {
      const r = runCli(["auth", "status"], store);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/disabled/i);
      expect(r.stdout).toMatch(/none/i);
    });
  });

  it("status reports configured methods + enabled flag, no secrets", async () => {
    await withStore(async (store: LibrarianStore) => {
      setOwnerPassword(store, "owner", "correct-horse-battery");
      setEnabled(store, true);
      const r = runCli(["auth", "status"], store);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/enabled/i);
      expect(r.stdout).toMatch(/password/i);
      expect(r.stdout).toContain("owner");
      expect(r.stdout).not.toMatch(/hash|salt/i);
    });
  });

  it("status --json emits the structured status", async () => {
    await withStore(async (store: LibrarianStore) => {
      setOwnerPassword(store, "owner", "correct-horse-battery");
      const r = runCli(["auth", "status", "--json"], store);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed).toMatchObject({ enabled: false, passwordUsername: "owner" });
      expect(parsed.methods).toContain("password");
    });
  });

  it("with no verb prints usage and exits non-zero", async () => {
    await withStore(async (store: LibrarianStore) => {
      const r = runCli(["auth"], store);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toMatch(/usage/i);
      expect(r.stdout).toMatch(/status/);
    });
  });

  it("rejects an unknown verb with usage", async () => {
    await withStore(async (store: LibrarianStore) => {
      const r = runCli(["auth", "bogus"], store);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toMatch(/unknown/i);
    });
  });

  describe("reset-password (D4.2)", () => {
    it("sets a new verifiable hash and clears the lockout", async () => {
      await withStore(async (store: LibrarianStore) => {
        setOwnerPassword(store, "owner", "old-password-here");
        for (let i = 0; i < 5; i++) authenticateOwner(store, "owner", "wrong-password-x");
        expect(getLockoutState(store).locked).toBe(true);

        const r = runCli(["auth", "reset-password", "--password", STRONG], store);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain("owner");
        expect(verifyOwnerPassword(store, "owner", STRONG)).toBe(true);
        expect(getLockoutState(store).locked).toBe(false);
      });
    });

    it("reuses the configured username when --username is omitted", async () => {
      await withStore(async (store: LibrarianStore) => {
        setOwnerPassword(store, "owner", "old-password-here");
        const r = runCli(["auth", "reset-password", "--password", STRONG], store);
        expect(r.exitCode).toBe(0);
        expect(verifyOwnerPassword(store, "owner", STRONG)).toBe(true);
      });
    });

    it("can set the username on first use via --username", async () => {
      await withStore(async (store: LibrarianStore) => {
        const r = runCli(
          ["auth", "reset-password", "--username", "newowner", "--password", STRONG],
          store,
        );
        expect(r.exitCode).toBe(0);
        expect(verifyOwnerPassword(store, "newowner", STRONG)).toBe(true);
      });
    });

    it("enforces the length floor", async () => {
      await withStore(async (store: LibrarianStore) => {
        setOwnerPassword(store, "owner", "old-password-here");
        const r = runCli(["auth", "reset-password", "--password", "short"], store);
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toMatch(/characters|length|at least/i);
      });
    });

    it("errors when no username is available", async () => {
      await withStore(async (store: LibrarianStore) => {
        const r = runCli(["auth", "reset-password", "--password", STRONG], store);
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toMatch(/username/i);
      });
    });

    it("prompts (no-echo) for the password when --password is omitted", async () => {
      await withStore(async (store: LibrarianStore) => {
        setOwnerPassword(store, "owner", "old-password-here");
        const r = resetPasswordCommand(store, [], {}, { promptPassword: () => STRONG });
        expect(r.exitCode).toBe(0);
        expect(verifyOwnerPassword(store, "owner", STRONG)).toBe(true);
      });
    });
  });

  describe("reset-password --print-setup-link (D4.3)", () => {
    it("mints a one-time link and prints a URL with the configured origin", async () => {
      await withStore(async (store: LibrarianStore) => {
        const r = runCli(
          ["auth", "reset-password", "--print-setup-link", "--origin", "https://dash.example.com"],
          store,
        );
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain("https://dash.example.com/settings/auth/reset?token=libsetup.");

        // The printed token is a real, consumable link.
        const token = r.stdout.match(/token=(libsetup\.[^\s]+)/)?.[1] as string;
        expect(consumeSetupLink(store, token)).toBe(true);
        expect(consumeSetupLink(store, token)).toBe(false); // single-use
      });
    });

    it("prints the path with a hint when no origin is given", async () => {
      await withStore(async (store: LibrarianStore) => {
        const r = runCli(["auth", "reset-password", "--print-setup-link"], store);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain("/settings/auth/reset?token=libsetup.");
        expect(r.stdout).toMatch(/origin/i);
      });
    });
  });

  describe("disable (D4.4)", () => {
    it("turns enforcement off (break-glass) and is idempotent", async () => {
      await withStore(async (store: LibrarianStore) => {
        setOwnerPassword(store, "owner", "correct-horse-battery");
        setEnabled(store, true);

        const first = runCli(["auth", "disable"], store);
        expect(first.exitCode).toBe(0);
        expect(getAuthStatus(store).enabled).toBe(false);

        // Running again is harmless.
        const second = runCli(["auth", "disable"], store);
        expect(second.exitCode).toBe(0);
        expect(getAuthStatus(store).enabled).toBe(false);
      });
    });
  });
});
