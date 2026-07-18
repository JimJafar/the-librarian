// `the-librarian auth <verb>` — host-shell auth setup + recovery.
//
// The self-hoster already has shell access, so lockout recovery lives here rather
// than needing new env vars: `status` (no secrets), `reset-password`, `disable`
// (break-glass). `mint-claim` signs a first-owner claim with the server's arming
// secret without touching the store. Verb dispatch mirrors `sessions <verb>`.

import {
  BOOTSTRAP_CLAIM_MAX_TTL_MS,
  assertBootstrapClaimSecret,
  getAuthStatus,
  mintBootstrapClaim,
  mintSetupLink,
  ownerPasswordUsername,
  resetLockout,
  setEnabled,
  setOwnerPassword,
} from "@librarian/core";
import type { FlagMap } from "../parse-flags.js";
import { readHiddenLine } from "../prompt.js";
import type { CliResult, Command } from "./_shared.js";

const statusCommand: Command = (store, _positionals, flags) => {
  const status = getAuthStatus(store);
  if (flags.json) return { stdout: JSON.stringify(status, null, 2), exitCode: 0 };
  const lines = [
    `Auth enforcement: ${status.enabled ? "ENABLED" : "disabled"}`,
    `Configured methods: ${status.methods.length ? status.methods.join(", ") : "(none)"}`,
  ];
  if (status.passwordUsername) lines.push(`Password username: ${status.passwordUsername}`);
  if (status.ownerOAuth.github) lines.push(`GitHub owner: ${status.ownerOAuth.github}`);
  if (status.ownerOAuth.google) lines.push(`Google owner: ${status.ownerOAuth.google}`);
  return { stdout: lines.join("\n"), exitCode: 0 };
};

const SETUP_LINK_TTL_MS = 15 * 60_000; // 15 minutes
const RESET_PATH = "/settings/auth/reset";
const DEFAULT_CLAIM_TTL_MINUTES = 15;
const MAX_CLAIM_TTL_MINUTES = BOOTSTRAP_CLAIM_MAX_TTL_MS / 60_000;
const CLAIM_PATH = "/claim";

export interface AuthCommandDeps {
  /** No-echo password prompt (injected in tests); returns null with no TTY. */
  promptPassword?: () => string | null;
}

/** Mint a one-time setup link and print a browser URL — keeps the new password out
 *  of shell history (the owner sets it in the browser). */
function printSetupLink(store: Parameters<Command>[0], flags: FlagMap): CliResult {
  const token = mintSetupLink(store, SETUP_LINK_TTL_MS);
  const path = `${RESET_PATH}?token=${token}`;
  const origin = (typeof flags.origin === "string" ? flags.origin.trim() : "").replace(/\/$/, "");
  if (origin) {
    return {
      stdout: `Open this one-time link (valid 15 minutes) to set a new password:\n${origin}${path}`,
      exitCode: 0,
    };
  }
  return {
    stdout: `Open this one-time link (valid 15 minutes) to set a new password — prepend your dashboard origin:\n${path}`,
    exitCode: 0,
  };
}

/**
 * `reset-password [--username <name>] [--password <pw>]` — set a new owner password
 * (inline or via a no-echo prompt) and clear any lockout. Reuses the configured
 * username when --username is omitted. The length floor is enforced by core.
 */
export function resetPasswordCommand(
  store: Parameters<Command>[0],
  _positionals: string[],
  flags: FlagMap,
  deps: AuthCommandDeps = {},
): CliResult {
  // --print-setup-link mints a one-time browser link instead of setting inline.
  if (flags["print-setup-link"]) return printSetupLink(store, flags);

  const username =
    (typeof flags.username === "string" ? flags.username.trim() : "") ||
    ownerPasswordUsername(store) ||
    "";
  if (!username) {
    return {
      stdout: "No password username is configured. Pass --username <name> to set one.",
      exitCode: 1,
    };
  }

  let password = typeof flags.password === "string" ? flags.password : "";
  if (!password) {
    const prompt = deps.promptPassword ?? (() => readHiddenLine("New password: "));
    const entered = prompt();
    if (!entered) {
      return {
        stdout: "No password provided. Pass --password <pw> or run in an interactive terminal.",
        exitCode: 1,
      };
    }
    password = entered;
  }

  try {
    setOwnerPassword(store, username, password);
  } catch (error) {
    return { stdout: `Password reset failed: ${(error as Error).message}`, exitCode: 1 };
  }
  resetLockout(store);
  return { stdout: `Password reset for "${username}". Any lockout has been cleared.`, exitCode: 0 };
}

// Break-glass: turn enforcement off. Ungated by design — a locked-out owner on the
// host must always be able to disable. Takes effect on a running dashboard within
// the auth-config cache TTL (30s); idempotent.
const disableCommand: Command = (store) => {
  setEnabled(store, false);
  return {
    stdout: "Auth enforcement disabled. A running dashboard picks this up within ~30s.",
    exitCode: 0,
  };
};

function mintClaimCommand(
  _store: Parameters<Command>[0],
  _positionals: string[],
  flags: FlagMap,
): CliResult {
  const email = typeof flags.email === "string" ? flags.email.trim() : "";
  if (!email) {
    return {
      stdout: "The --email <email> flag is required to mint a first-owner claim.",
      exitCode: 1,
    };
  }

  const secret = process.env.LIBRARIAN_BOOTSTRAP_CLAIM_SECRET;
  if (!secret) {
    return {
      stdout:
        "LIBRARIAN_BOOTSTRAP_CLAIM_SECRET is not set. Set it to the same 32+ character value used to arm the server, then retry.",
      exitCode: 1,
    };
  }
  try {
    assertBootstrapClaimSecret(secret);
  } catch (error) {
    return { stdout: (error as Error).message, exitCode: 1 };
  }

  let ttlMinutes = DEFAULT_CLAIM_TTL_MINUTES;
  if (flags["ttl-minutes"] !== undefined) {
    const rawTtl = flags["ttl-minutes"];
    const parsed = typeof rawTtl === "string" && /^\d+$/.test(rawTtl) ? Number(rawTtl) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CLAIM_TTL_MINUTES) {
      return {
        stdout: `--ttl-minutes must be a whole number from 1 to ${MAX_CLAIM_TTL_MINUTES}.`,
        exitCode: 1,
      };
    }
    ttlMinutes = parsed;
  }

  let returnTo: string | undefined;
  if (flags["return-to"] !== undefined) {
    const rawReturnTo = flags["return-to"];
    if (typeof rawReturnTo !== "string") {
      return {
        stdout: "--return-to requires an https:// URL.",
        exitCode: 1,
      };
    }
    try {
      const parsed = new URL(rawReturnTo);
      if (parsed.protocol !== "https:") throw new Error("not HTTPS");
      returnTo = parsed.toString();
    } catch {
      return {
        stdout: "--return-to must be a valid https:// URL.",
        exitCode: 1,
      };
    }
  }

  const now = new Date();
  try {
    const token = mintBootstrapClaim(
      secret,
      {
        email,
        expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
        ...(returnTo === undefined ? {} : { returnTo }),
      },
      now,
    );
    return {
      stdout: [
        `First-owner claim token (valid ${ttlMinutes} minutes):`,
        token,
        "",
        "Open this path on the armed dashboard:",
        `${CLAIM_PATH}?token=${token}`,
      ].join("\n"),
      exitCode: 0,
    };
  } catch {
    return {
      stdout:
        "Claim minting failed. Pass a valid email address and an optional https:// return target.",
      exitCode: 1,
    };
  }
}

export const authVerbs: Record<string, Command> = {
  status: statusCommand,
  "reset-password": resetPasswordCommand,
  "mint-claim": mintClaimCommand,
  disable: disableCommand,
};

export function authUsage(): string {
  return [
    "Usage: the-librarian auth <verb> [flags]",
    "",
    "Verbs:",
    "  status                        Show configured methods + enforcement (no secrets)",
    "  reset-password                Set a new owner password and clear lockout",
    "  mint-claim                    Mint a short-lived first-owner claim",
    "  disable                       Turn off enforcement (break-glass)",
    "",
    "Flags:",
    "  --json                        status: emit JSON instead of prose",
    "  --username <name>             reset-password: owner username (default: the configured one)",
    "  --password <pw>               reset-password: new password (omit to be prompted, no echo)",
    "  --print-setup-link            reset-password: mint a one-time browser link instead",
    "  --origin <url>                reset-password: dashboard origin for the printed link",
    "  --email <email>               mint-claim: owner email (required)",
    "  --ttl-minutes <n>             mint-claim: validity, 1–1440 minutes (default: 15)",
    "  --return-to <https-url>       mint-claim: post-claim HTTPS destination",
  ].join("\n");
}
