// Boot credential resolution (dashboard-managed-auth, D0.3).
//
// A pure decision matrix that turns the environment + data volume into the master
// key the server boots with. Extracted from the bin so it's unit-testable with an
// injected fake fs (no disk, no process). The bin (D0.4) calls this once and acts
// on the returned signals (one-time logs).
//
// Precedence is "env wins, then the data volume, then generate":
//   secret key  : env LIBRARIAN_SECRET_KEY → ${dataDir}/secret.key → generate
//                 (writable) → null (read-only volume: no-secrets fallback, no crash)
//
// ADR 0008 P3: the admin token is NO LONGER a boot credential. The admin tRPC API
// is served only on the trusted internal listener (off the network), so there is
// nothing for an admin token to gate — boot neither resolves, generates, nor
// persists one. (Master-key externalization is owned separately by P4.)

import fs from "node:fs";
import path from "node:path";
import { type FileIo, loadOrCreateSecretKeyFile, resolveSecretKey } from "../secret-crypto.js";

const SECRET_KEY_FILE = "secret.key";

export type CredentialSource = "env" | "file" | "generated" | "absent";

export interface BootCredentialSignal {
  credential: "secret-key";
  source: CredentialSource;
  /** The file path involved, for `file`/`generated` sources (so the bin can log it). */
  path?: string;
}

export interface ResolvedBootCredentials {
  secretKey: Buffer | null;
  signals: BootCredentialSignal[];
}

export interface BootCredentialsInput {
  env: Record<string, string | undefined>;
  dataDir: string;
  io?: FileIo;
}

/** Map a load helper's `generated` flag to a signal source. */
function loadedSource(generated: boolean): "generated" | "file" {
  return generated ? "generated" : "file";
}

/**
 * Run a credential-file load, distinguishing the two failure modes the resolver
 * treats differently: a malformed *existing* file is an operator signal (rethrow,
 * fail loud), while a *write* failure — the file is absent and the volume is
 * read-only — means we simply can't persist, so fall back to "absent" instead of
 * crashing. Returns the loaded value, or null for the absent/can't-persist case.
 */
function loadOrAbsent<T extends { generated: boolean }>(
  filePath: string,
  io: FileIo,
  load: () => T,
): T | null {
  try {
    return load();
  } catch (error) {
    // Classify by presence: a file that's there now is a malformed/unreadable
    // existing file (rethrow); absent means the write itself failed (read-only
    // volume) → fall back to null. The re-check races a concurrent creator in
    // theory, but the store is single-owner so that window doesn't occur here.
    if (io.existsSync(filePath)) throw error;
    return null;
  }
}

export function resolveBootCredentials(input: BootCredentialsInput): ResolvedBootCredentials {
  const io = input.io ?? fs;
  const signals: BootCredentialSignal[] = [];

  const secretKey = resolveSecretKeyCredential(input, io, signals);
  return { secretKey, signals };
}

function resolveSecretKeyCredential(
  input: BootCredentialsInput,
  io: FileIo,
  signals: BootCredentialSignal[],
): Buffer | null {
  const envKey = (input.env.LIBRARIAN_SECRET_KEY ?? "").trim();
  if (envKey) {
    // A present-but-bad env key throws (fail loud) — same as today's boot.
    const key = resolveSecretKey(envKey);
    signals.push({ credential: "secret-key", source: "env" });
    return key;
  }

  const keyPath = path.join(input.dataDir, SECRET_KEY_FILE);
  const loaded = loadOrAbsent(keyPath, io, () => loadOrCreateSecretKeyFile(keyPath, io));
  if (!loaded) {
    signals.push({ credential: "secret-key", source: "absent" });
    return null;
  }
  signals.push({ credential: "secret-key", source: loadedSource(loaded.generated), path: keyPath });
  return loaded.key;
}
