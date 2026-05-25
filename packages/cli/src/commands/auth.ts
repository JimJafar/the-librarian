// `the-librarian auth <verb>` — host-shell auth recovery (dashboard-managed-auth, D4).
//
// The self-hoster already has shell access, so lockout recovery lives here rather
// than needing new env vars: `status` (no secrets), `reset-password`, `disable`
// (break-glass). Verb dispatch mirrors `sessions <verb>`. These all operate on plain
// settings (the password is a one-way hash, the enabled flag and setup links are
// plain), so no master key is required.

import {
  getAuthStatus,
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

export const authVerbs: Record<string, Command> = {
  status: statusCommand,
  "reset-password": resetPasswordCommand,
  disable: disableCommand,
};

export function authUsage(): string {
  return [
    "Usage: the-librarian auth <verb> [flags]",
    "",
    "Verbs:",
    "  status                        Show configured methods + enforcement (no secrets)",
    "  reset-password                Set a new owner password and clear lockout",
    "  disable                       Turn off enforcement (break-glass)",
    "",
    "Flags:",
    "  --json                        status: emit JSON instead of prose",
    "  --username <name>             reset-password: owner username (default: the configured one)",
    "  --password <pw>               reset-password: new password (omit to be prompted, no echo)",
    "  --print-setup-link            reset-password: mint a one-time browser link instead",
    "  --origin <url>                reset-password: dashboard origin for the printed link",
  ].join("\n");
}
