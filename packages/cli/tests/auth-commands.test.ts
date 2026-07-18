import {
  type LibrarianStore,
  authenticateOwner,
  consumeSetupLink,
  getAuthStatus,
  getLockoutState,
  setEnabled,
  setOwnerPassword,
  verifyBootstrapClaim,
  verifyOwnerPassword,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withStore } from "../../../test/helpers.js";
import { resetPasswordCommand } from "../src/commands/auth.js";
import { runCli } from "../src/runtime.js";

const STRONG = "new-strong-password";
const CLAIM_SECRET = "claim-test-material-".repeat(2);
const priorClaimSecret = process.env.LIBRARIAN_BOOTSTRAP_CLAIM_SECRET;

beforeEach(() => {
  process.env.LIBRARIAN_BOOTSTRAP_CLAIM_SECRET = CLAIM_SECRET;
});

afterEach(() => {
  if (priorClaimSecret === undefined) delete process.env.LIBRARIAN_BOOTSTRAP_CLAIM_SECRET;
  else process.env.LIBRARIAN_BOOTSTRAP_CLAIM_SECRET = priorClaimSecret;
});

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

  describe("mint-claim", () => {
    it("prints a ready-made claim path whose token verifies with a normalised email", async () => {
      await withStore(async (store: LibrarianStore) => {
        const r = runCli(["auth", "mint-claim", "--email", " Owner@Example.COM "], store);

        expect(r.exitCode).toBe(0);
        const token = r.stdout.match(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/m)?.[0];
        expect(token).toBeDefined();
        expect(r.stdout).toContain(`/claim?token=${token}`);
        expect(verifyBootstrapClaim(CLAIM_SECRET, token as string).email).toBe("owner@example.com");
      });
    });

    it("honours a bounded TTL and embeds an HTTPS return target", async () => {
      await withStore(async (store: LibrarianStore) => {
        const before = Math.floor(Date.now() / 1000);
        const r = runCli(
          [
            "auth",
            "mint-claim",
            "--email",
            "owner@example.com",
            "--ttl-minutes",
            "1440",
            "--return-to",
            "https://console.example.test/claimed?tenant=tenant-1",
          ],
          store,
        );

        expect(r.exitCode).toBe(0);
        const token = r.stdout.match(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/m)?.[0];
        const claim = verifyBootstrapClaim(CLAIM_SECRET, token as string);
        expect(claim.returnTo).toBe("https://console.example.test/claimed?tenant=tenant-1");
        expect(claim.exp).toBeGreaterThanOrEqual(before + 1440 * 60 - 1);
        expect(claim.exp).toBeLessThanOrEqual(before + 1440 * 60 + 1);
      });
    });

    it.each(["0", "-1", "1.5", "1441", "not-a-number"])(
      "rejects invalid --ttl-minutes %s with its valid range",
      async (ttl) => {
        await withStore(async (store: LibrarianStore) => {
          const r = runCli(
            ["auth", "mint-claim", "--email", "owner@example.com", "--ttl-minutes", ttl],
            store,
          );

          expect(r.exitCode).toBe(1);
          expect(r.stdout).toMatch(/whole number.*1.*1440/i);
          expect(r.stdout).not.toContain("/claim?token=");
        });
      },
    );

    it("rejects an absent or short arming secret with a teaching error", async () => {
      await withStore(async (store: LibrarianStore) => {
        delete process.env.LIBRARIAN_BOOTSTRAP_CLAIM_SECRET;
        const absent = runCli(["auth", "mint-claim", "--email", "owner@example.com"], store);
        expect(absent.exitCode).toBe(1);
        expect(absent.stdout).toMatch(/LIBRARIAN_BOOTSTRAP_CLAIM_SECRET.*set/i);

        process.env.LIBRARIAN_BOOTSTRAP_CLAIM_SECRET = "too-short";
        const short = runCli(["auth", "mint-claim", "--email", "owner@example.com"], store);
        expect(short.exitCode).toBe(1);
        expect(short.stdout).toMatch(/LIBRARIAN_BOOTSTRAP_CLAIM_SECRET.*at least 32/i);
      });
    });

    it("requires an email and an HTTPS return target", async () => {
      await withStore(async (store: LibrarianStore) => {
        const missingEmail = runCli(["auth", "mint-claim"], store);
        expect(missingEmail.exitCode).toBe(1);
        expect(missingEmail.stdout).toMatch(/--email <email>.*required/i);

        const insecureReturn = runCli(
          [
            "auth",
            "mint-claim",
            "--email",
            "owner@example.com",
            "--return-to",
            "http://console.example.test/claimed",
          ],
          store,
        );
        expect(insecureReturn.exitCode).toBe(1);
        expect(insecureReturn.stdout).toMatch(/--return-to.*https/i);
      });
    });
  });
});
