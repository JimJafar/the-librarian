// `the-librarian restore [--secret-key <hex>] [--force]` — the INVERSE of
// `backup`. Backup pushes the vault (a git repo) to the configured GitHub backup
// remote; restore CLONES that remote back into the data dir's vault so the server
// can serve the recovered memories. Runs INSIDE the all-in-one container (via
// `librarian server admin restore`), against the live data dir.
//
// The crux is the master key (spec §6/§7): the key is DELIBERATELY excluded from
// backups, so a restore can clone every memory back but cannot decrypt the
// admin secret-store without the operator re-supplying the key. We therefore take
// `--secret-key` (or prompt for it, no-echo, when interactive), validate it, and
// place it at `${dataDir}/secret.key` (0600) so the server boots able to decrypt.
//
// Guards (never silently clobber a populated data dir):
//   - no backup remote configured → teaching error (nothing to restore from).
//   - secret key absent + non-interactive → teaching error naming the exclusion.
//   - malformed secret key → teaching error (validated BEFORE any write/clone).
//   - non-empty vault without --force → refuse (don't clobber live memories).
//   - a DIFFERING existing secret.key without --force → refuse (overwriting the
//     master key on a populated data dir orphans every already-encrypted secret).
//
// The clone is injected (`deps.clone`) so tests pin the guards + argv without
// reaching github.com; production defaults to core's token-safe `cloneVaultBackup`.

import fs from "node:fs";
import path from "node:path";
import {
  type LibrarianStore,
  cloneVaultBackup,
  resolveBackupRemote,
  resolveSecretKey,
  resolveVaultPath,
  writeSecretKeyFile,
} from "@librarian/core";
import { type FlagMap, flagString } from "../parse-flags.js";
import { readHiddenLine } from "../prompt.js";
import type { CliResult } from "./_shared.js";

const SECRET_KEY_FILE = "secret.key";

export interface RestoreCommandDeps {
  /** Clone the backup remote into `dest` (injected in tests; default: core). */
  clone?: (opts: { remoteUrl: string; branch: string; token: string; dest: string }) => void;
  /** No-echo secret-key prompt (injected in tests); returns null when cancelled. */
  promptSecretKey?: () => string | null;
  /** Whether a TTY is attached (so we may prompt). Default: `process.stdin.isTTY`. */
  interactive?: boolean;
}

function ok(stdout: string): CliResult {
  return { stdout, exitCode: 0 };
}
function fail(stdout: string): CliResult {
  return { stdout, exitCode: 1 };
}

/**
 * True when `dir` holds actual vault CONTENT — any entry other than `.git`. A
 * freshly-constructed store git-initialises an otherwise-empty `vault/` (it
 * contains only `.git`), which is logically empty and safe to restore over; only
 * real memories (memories/inbox/references/… or any committed file) count as
 * populated and trigger the clobber guard.
 */
function isPopulatedVault(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((entry) => entry !== ".git");
  } catch {
    return false; // absent → empty
  }
}

/**
 * Resolve + validate the operator-supplied master key: `--secret-key` wins;
 * otherwise prompt (no-echo) when interactive; otherwise a teaching error naming
 * that the key is excluded from backups and must be supplied. A present-but-
 * malformed key is a teaching error too — and (crucially) we validate BEFORE any
 * clone or write, so a bad key never clobbers the data dir.
 *
 * Returns the canonical 64-hex key on success, or a `CliResult` error to return.
 */
function resolveSuppliedKey(
  flags: FlagMap,
  deps: RestoreCommandDeps,
): { keyHex: string } | { error: CliResult } {
  let raw = flagString(flags["secret-key"]);
  if (raw === undefined || raw.trim() === "") {
    const interactive = deps.interactive ?? process.stdin.isTTY === true;
    if (!interactive) {
      return {
        error: fail(
          "restore needs the secret key (the master key), which is excluded from backups " +
            "by design — supply it with --secret-key <hex>.\n" +
            "Without it the vault restores but the server cannot decrypt restored secrets " +
            "(e.g. the curator's LLM token). It is the 64-char hex key surfaced once at " +
            "`server up` (SAVE THIS KEY).",
        ),
      };
    }
    const prompt =
      deps.promptSecretKey ?? (() => readHiddenLine("Master key (hex, excluded from backups): "));
    const entered = prompt();
    if (!entered) {
      return {
        error: fail(
          "No master key provided. Pass --secret-key <hex> or enter it at the prompt — " +
            "it is excluded from backups and must be re-supplied to decrypt restored secrets.",
        ),
      };
    }
    raw = entered;
  }

  try {
    // Validate (and canonicalise) without writing anything yet.
    return { keyHex: resolveSecretKey(raw).toString("hex") };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: fail(
        `Malformed --secret-key: ${message}.\n` +
          "Expected the 64-char hex (or base64) master key surfaced at `server up`.",
      ),
    };
  }
}

export function restoreCommand(
  store: LibrarianStore,
  _positionals: string[],
  flags: FlagMap,
  deps: RestoreCommandDeps = {},
): CliResult {
  const force = flags.force === true;

  // 1. Resolve the backup remote the SAME way `backup` does.
  const remote = resolveBackupRemote(store);
  if (!remote) {
    return fail(
      "No backup remote configured — there is nothing to restore from. " +
        "Set the GitHub repo + token in the backup settings first, then re-run restore.",
    );
  }

  // 2. Resolve + validate the master key (BEFORE any clone/write).
  const keyResult = resolveSuppliedKey(flags, deps);
  if ("error" in keyResult) return keyResult.error;
  const { keyHex } = keyResult;

  // 3. Clobber guards — refuse to silently overwrite a populated data dir.
  const vaultDir = resolveVaultPath({ dataDir: store.dataDir });
  if (!force && isPopulatedVault(vaultDir)) {
    return fail(
      `The vault at ${vaultDir} already contains memories — refusing to overwrite them. ` +
        "Re-run with --force to replace the existing vault with the backup.",
    );
  }

  const keyFile = path.join(store.dataDir, SECRET_KEY_FILE);
  if (!force && fs.existsSync(keyFile)) {
    const existing = (() => {
      try {
        return resolveSecretKey(fs.readFileSync(keyFile, "utf8")).toString("hex");
      } catch {
        return null; // unreadable/malformed existing key → treat as differing
      }
    })();
    if (existing !== keyHex) {
      return fail(
        `A different ${SECRET_KEY_FILE} already exists at ${keyFile} — refusing to overwrite ` +
          "the master key on a populated data dir (it would orphan every already-encrypted " +
          "secret). Re-run with --force if you mean to replace it.",
      );
    }
  }

  // 4. Clone the backup into the vault. git clone refuses an existing non-empty
  //    dest, and the store git-initialises an empty `vault/` (it holds `.git`)
  //    on construction — so always clear the dest first. The guard above already
  //    secured the operator's consent before we reach a POPULATED vault.
  const clone = deps.clone ?? cloneVaultBackup;
  try {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    clone({
      remoteUrl: remote.auth.remoteUrl,
      branch: remote.auth.branch,
      token: remote.auth.token,
      dest: vaultDir,
    });
  } catch (err) {
    // Clone errors are already token-scrubbed at the clone site.
    const message = err instanceof Error ? err.message : String(err);
    return fail(`Restore failed while cloning ${remote.repo}: ${message}`);
  }

  // 5. Place the supplied master key (0600) so the server can decrypt secrets.
  try {
    writeSecretKeyFile(keyFile, keyHex, { force });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`Restore cloned the vault but could not write ${SECRET_KEY_FILE}: ${message}`);
  }

  // 6. Reindex the recall index from the restored vault (same path as `rebuild`).
  store.reindex();

  return ok(
    `Restored the vault from ${remote.repo} into ${vaultDir}, placed ${SECRET_KEY_FILE} (0600), ` +
      "and rebuilt the recall index.",
  );
}
