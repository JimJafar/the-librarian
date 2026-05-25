// `the-librarian restore --from <backup-dir> --force [--secret-key <key>]`
//
// Destructive: it overwrites the data dir, so it requires --force. It closes the
// store first (the SQLite file is replaced) — restore is terminal, so the handle
// stays closed; the bin's own close is idempotent.
//
// D0.6 — backups are key-free, so a cross-host restore lands encrypted secrets with
// no master key on the new host. After restoring, if the data contains secrets we
// resolve the key (--secret-key → env → TTY prompt), verify it actually decrypts
// them, and persist it to ${dataDir}/secret.key (mode 0600) so the next server boot
// can read it. A key supplied via env is honored but NOT persisted — that respects
// the deliberate key/data separation an env-only operator has chosen.

import fs from "node:fs";
import path from "node:path";
import {
  BackupRestoreError,
  type LibrarianStore,
  createLibrarianStore,
  resolveSecretKey,
  restoreBackup,
} from "@librarian/core";
import type { FlagMap } from "../parse-flags.js";
import type { CliResult } from "./_shared.js";

const SECRET_KEY_FILE = "secret.key";
const MAX_PROMPTS = 3;

/** The slice of a store the key-verification probe needs (small, so tests can fake it). */
type VerifyStore = Pick<LibrarianStore, "listSettings" | "getSetting" | "close">;

export interface RestoreDeps {
  /** Open a store at `dataDir` with a candidate key (default: the real store). */
  openStore?: (dataDir: string, secretKey: Buffer | null) => VerifyStore;
  /** Prompt the operator for the master key; returns null when there's no TTY. */
  promptSecretKey?: () => string | null;
  /** Persist the validated key to the data dir (default: write secret.key 0600). */
  writeKeyFile?: (dataDir: string, keyHex: string) => void;
  /** Environment to read LIBRARIAN_SECRET_KEY from (default: process.env). */
  env?: Record<string, string | undefined>;
}

function defaultPromptSecretKey(): string | null {
  if (!process.stdin.isTTY) return null;
  process.stdout.write(
    "Enter the master key (LIBRARIAN_SECRET_KEY) to decrypt the restored secrets: ",
  );
  const buf = Buffer.alloc(4096);
  try {
    const read = fs.readSync(0, buf, 0, buf.length, null);
    return buf.toString("utf8", 0, read).trim() || null;
  } catch {
    return null;
  }
}

function defaultWriteKeyFile(dataDir: string, keyHex: string): void {
  fs.writeFileSync(path.join(dataDir, SECRET_KEY_FILE), keyHex, { mode: 0o600 });
}

function resolveDeps(deps: RestoreDeps): Required<RestoreDeps> {
  return {
    openStore:
      deps.openStore ?? ((dataDir, secretKey) => createLibrarianStore({ dataDir, secretKey })),
    promptSecretKey: deps.promptSecretKey ?? defaultPromptSecretKey,
    writeKeyFile: deps.writeKeyFile ?? defaultWriteKeyFile,
    env: deps.env ?? process.env,
  };
}

/** The key of one secret setting (to probe decryption), or null if there are none. */
function firstSecretSettingKey(
  dataDir: string,
  open: Required<RestoreDeps>["openStore"],
): string | null {
  const store = open(dataDir, null); // listSettings is metadata-only — no key needed
  try {
    return store.listSettings().find((s) => s.is_secret)?.key ?? null;
  } finally {
    store.close();
  }
}

type KeyAttempt = { ok: true; keyHex: string } | { ok: false; malformed: boolean };

/** Does this raw key decrypt the probe secret? */
function tryKey(
  raw: string,
  dataDir: string,
  probeKey: string,
  open: Required<RestoreDeps>["openStore"],
): KeyAttempt {
  let key: Buffer;
  try {
    key = resolveSecretKey(raw);
  } catch {
    return { ok: false, malformed: true };
  }
  const store = open(dataDir, key);
  try {
    store.getSetting(probeKey); // throws on a wrong key (GCM auth failure)
    return { ok: true, keyHex: key.toString("hex") };
  } catch {
    return { ok: false, malformed: false };
  } finally {
    store.close();
  }
}

export function restoreCommand(
  store: LibrarianStore,
  _positionals: string[],
  flags: FlagMap,
  deps: RestoreDeps = {},
): CliResult {
  const from = typeof flags.from === "string" ? flags.from : "";
  if (!from) {
    return { stdout: "restore requires --from <backup-dir>.", exitCode: 1 };
  }
  if (flags.force !== true) {
    return {
      stdout: `restore OVERWRITES the data dir (${store.dataDir}). Re-run with --force once you're sure.`,
      exitCode: 1,
    };
  }

  const dataDir = store.dataDir;
  store.close(); // release the SQLite handle before the file is replaced

  let baseline: string;
  try {
    const result = restoreBackup(from, { dataDir });
    baseline = `Restored ${result.restored.length} files to ${result.dataDir} (schema v${result.schemaVersion}). Restart the server.`;
  } catch (err) {
    if (err instanceof BackupRestoreError) {
      return { stdout: `Restore failed: ${err.message}`, exitCode: 1 };
    }
    throw err;
  }

  return verifyRestoredSecrets(dataDir, baseline, flags, resolveDeps(deps));
}

function verifyRestoredSecrets(
  dataDir: string,
  baseline: string,
  flags: FlagMap,
  deps: Required<RestoreDeps>,
): CliResult {
  const probeKey = firstSecretSettingKey(dataDir, deps.openStore);
  if (!probeKey) {
    return { stdout: baseline, exitCode: 0 }; // no encrypted secrets — nothing to unlock
  }

  // 1) Explicit --secret-key: a wrong/malformed one errors clearly (no silent prompt).
  const flagKey = typeof flags["secret-key"] === "string" ? (flags["secret-key"] as string) : "";
  if (flagKey) {
    const attempt = tryKey(flagKey, dataDir, probeKey, deps.openStore);
    if (attempt.ok) return persisted(baseline, dataDir, attempt.keyHex, "--secret-key", deps);
    const why = attempt.malformed ? "is malformed" : "does not decrypt the restored secrets";
    return {
      stdout: `Restore failed: the provided --secret-key ${why} (wrong key?).`,
      exitCode: 1,
    };
  }

  // 2) Env key (honored but not persisted — respects key/data separation).
  const envKey = (deps.env.LIBRARIAN_SECRET_KEY ?? "").trim();
  if (envKey) {
    const attempt = tryKey(envKey, dataDir, probeKey, deps.openStore);
    if (attempt.ok) {
      return {
        stdout: `${baseline} Verified the restored secrets with LIBRARIAN_SECRET_KEY from the environment.`,
        exitCode: 0,
      };
    }
    // A wrong env key falls through to the prompt — the operator can supply the right one.
  }

  // 3) Prompt on a TTY, bounded retries.
  for (let i = 0; i < MAX_PROMPTS; i++) {
    const raw = deps.promptSecretKey();
    if (!raw) break; // no TTY, or the operator gave up
    const attempt = tryKey(raw, dataDir, probeKey, deps.openStore);
    if (attempt.ok) return persisted(baseline, dataDir, attempt.keyHex, "the entered key", deps);
  }

  // 4) Nothing worked / non-interactive — actionable, not a stack trace.
  return {
    stdout: `${baseline}\nThe restored data contains encrypted secrets. Re-run with --secret-key <key> (or set LIBRARIAN_SECRET_KEY) to unlock them.`,
    exitCode: 1,
  };
}

function persisted(
  baseline: string,
  dataDir: string,
  keyHex: string,
  source: string,
  deps: Required<RestoreDeps>,
): CliResult {
  deps.writeKeyFile(dataDir, keyHex);
  return {
    stdout: `${baseline} Verified the restored secrets with ${source} and saved the master key to ${path.join(dataDir, SECRET_KEY_FILE)}.`,
    exitCode: 0,
  };
}
