// The CLI bin's store factory.
//
// Unlike the long-running server (which resolves the master key at boot), the
// `the-librarian` CLI previously built its store with NO key
// (`createLibrarianStore()`), so it could not DECRYPT secret settings. That made
// `restore` (and any admin verb that reads an encrypted setting) fail to see
// dashboard-saved config — e.g. `resolveBackupRemote` returned null because the
// encrypted `backup.github.token` read threw and was swallowed → the misleading
// "No backup remote configured" on a deployment that HAD a remote configured.
//
// Resolution mirrors boot's "env wins, then the data volume" order —
//   LIBRARIAN_SECRET_KEY → <dataDir>/secret.key → null
// — but NEVER generates a key: the CLI is a transient client of an already-keyed
// data dir, and minting one here would write a stray key that can't decrypt the
// server's existing secrets. With no key resolvable the store stays keyless
// (secret reads still fail), exactly as before; on a normal deploy the key is in
// env or on the data volume, so admin verbs can now read encrypted config.

import fs from "node:fs";
import path from "node:path";
import {
  type LibrarianStore,
  createLibrarianStore,
  resolveDataDir,
  resolveOptionalSecretKey,
} from "@librarian/core";

const SECRET_KEY_FILE = "secret.key";

function readFileOrUndefined(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined; // absent/unreadable → no file-resident key
  }
}

/**
 * Resolve the master key for a CLI invocation: `LIBRARIAN_SECRET_KEY` env →
 * `<dataDir>/secret.key` → null. NEVER generates one (see the file header).
 * Exported for the regression test.
 */
export function resolveCliSecretKey(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Buffer | null {
  const raw = env.LIBRARIAN_SECRET_KEY ?? readFileOrUndefined(path.join(dataDir, SECRET_KEY_FILE));
  return resolveOptionalSecretKey(raw);
}

/**
 * Build the store the CLI bin uses — keyed (when a key is resolvable) so it can
 * read encrypted settings.
 */
export function createCliStore(env: NodeJS.ProcessEnv = process.env): LibrarianStore {
  const dataDir = resolveDataDir(undefined);
  return createLibrarianStore({ dataDir, secretKey: resolveCliSecretKey(dataDir, env) });
}
