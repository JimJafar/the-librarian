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

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  type LibrarianStore,
  cloneVaultBackup,
  createJsonSettingsStore,
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
 * True when `dir` holds actual vault CONTENT. Two ways to be populated:
 *   - a working-tree entry other than `.git` (real memories on disk), OR
 *   - a committed HEAD (S-3): a `.git`-only dir whose history holds real
 *     committed memories is NOT logically empty — clobbering it would lose that
 *     history. A freshly-constructed store git-initialises an EMPTY `vault/`
 *     (`.git` present but NO commits yet), which has no HEAD and is safe to
 *     restore over.
 * Either condition triggers the clobber guard.
 */
function isPopulatedVault(dir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false; // absent → empty
  }
  if (entries.some((entry) => entry !== ".git")) return true;
  if (!entries.includes(".git")) return false; // empty dir, not even git-initialised
  // `.git`-only: populated iff there is a committed HEAD (real history to lose).
  return hasCommittedHead(dir);
}

/** True iff `git -C <dir> rev-parse HEAD` resolves a commit (the vault has history). */
function hasCommittedHead(dir: string): boolean {
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--verify", "HEAD"], { stdio: "ignore" });
    return true;
  } catch {
    return false; // no commits yet (or not a git repo) → empty
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

  // 4. Clone the backup into a TEMP sibling dir FIRST, then atomic-swap it into
  //    place (I-1). git clone refuses an existing non-empty dest, so we clone a
  //    pristine temp. CRUCIALLY the existing vault is NOT touched until the clone
  //    succeeds: if `clone` throws, the operator's original vault stays intact.
  const clone = deps.clone ?? cloneVaultBackup;
  const tempDir = `${vaultDir}.restore-${process.pid}-${Date.now()}`;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true }); // never clone onto a stale temp
    clone({
      remoteUrl: remote.auth.remoteUrl,
      branch: remote.auth.branch,
      token: remote.auth.token,
      dest: tempDir,
      // The GIT_ASKPASS helper must run; a read_only container's /tmp is noexec.
      // The data dir is writable + exec-capable (see runGitWithToken).
      scratchDir: store.dataDir,
    });
  } catch (err) {
    // Clone errors are already token-scrubbed at the clone site. The original
    // vault is UNTOUCHED — clean up the half-cloned temp and surface the error.
    fs.rmSync(tempDir, { recursive: true, force: true });
    const message = err instanceof Error ? err.message : String(err);
    return fail(
      `Restore failed while cloning ${remote.repo}: ${message}\n` +
        `Your existing vault at ${vaultDir} was left untouched.`,
    );
  }

  // 5. VERIFY the supplied key actually decrypts this data dir's secrets (I-2)
  //    BEFORE we swap the clone in or write the key. A shape-valid but WRONG key
  //    would otherwise leave a server that can't decrypt any restored secret.
  //    Verification reads the existing encrypted secret-store (settings.json,
  //    which lives beside the vault and is unaffected by the clone) and attempts
  //    a real decryption. No encrypted secret to check → skip (nothing to
  //    orphan). On failure we abort with NOTHING swapped and the key NOT left
  //    active — the original vault + key survive.
  const verification = verifyKeyDecryptsExistingSecret(store.dataDir, keyHex);
  if (verification.outcome === "mismatch") {
    fs.rmSync(tempDir, { recursive: true, force: true });
    return fail(
      "The supplied --secret-key does not decrypt this backup's existing secrets — it is " +
        "not the master key these secrets were encrypted with. Restore aborted: the wrong " +
        "key was NOT made active, and your existing vault + secret.key were left untouched.\n" +
        "Re-run with the 64-char hex master key surfaced at `server up` (SAVE THIS KEY).",
    );
  }

  // 6. Atomic-ish swap: remove the old vault, then move the verified clone into
  //    place. The clone already succeeded and the key already verified, so the
  //    destructive step happens only once we know the restore can complete.
  fs.rmSync(vaultDir, { recursive: true, force: true });
  fs.renameSync(tempDir, vaultDir);

  // 7. Place the supplied master key (0600) so the server can decrypt secrets.
  try {
    writeSecretKeyFile(keyFile, keyHex, { force });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`Restore cloned the vault but could not write ${SECRET_KEY_FILE}: ${message}`);
  }

  // 8. Reindex the recall index from the restored vault (same path as `rebuild`).
  store.reindex();

  const verifyNote =
    verification.outcome === "verified"
      ? "verified the supplied key decrypts the restored secrets, "
      : "no encrypted secrets to verify the key against (skipped that check), ";
  return ok(
    `Restored the vault from ${remote.repo} into ${vaultDir}, ${verifyNote}` +
      `placed ${SECRET_KEY_FILE} (0600), and rebuilt the recall index.`,
  );
}

/**
 * Verify the operator-supplied master key actually decrypts this data dir's
 * existing secret-store (I-2). The encrypted admin secrets live in
 * `<dataDir>/settings.json` (beside, not inside, the git vault), so a populated
 * data dir carries them even after the vault is re-cloned. We open that store
 * with the SUPPLIED key and attempt to decrypt the first secret entry — a wrong
 * key fails the AES-GCM authentication and throws (`decryptSecret` never returns
 * unauthenticated plaintext). Outcomes:
 *   - `verified`: a secret decrypted cleanly under the supplied key.
 *   - `skip`: there are no encrypted secrets to check (nothing to orphan).
 *   - `mismatch`: an encrypted secret exists but the key fails to decrypt it.
 */
function verifyKeyDecryptsExistingSecret(
  dataDir: string,
  keyHex: string,
): { outcome: "verified" | "skip" | "mismatch" } {
  const settings = createJsonSettingsStore({
    filePath: path.join(dataDir, "settings.json"),
    secretKey: resolveSecretKey(keyHex),
  });
  const firstSecret = settings.listSettings().find((entry) => entry.is_secret);
  if (!firstSecret) return { outcome: "skip" };
  try {
    settings.getSetting(firstSecret.key); // decrypts under the supplied key
    return { outcome: "verified" };
  } catch {
    return { outcome: "mismatch" };
  }
}
