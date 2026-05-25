// Boot credential resolution (dashboard-managed-auth, D0.3).
//
// A pure decision matrix that turns the environment + data volume into the master
// key and admin token the server boots with. Extracted from the bin so it's unit-
// testable with an injected fake fs (no disk, no process). The bin (D0.4) calls
// this once and acts on the returned signals (one-time logs, fatal checks).
//
// Precedence is "env wins, then the data volume, then generate":
//   secret key  : env LIBRARIAN_SECRET_KEY → ${dataDir}/secret.key → generate
//                 (writable) → null (read-only volume: no-secrets fallback, no crash)
//   admin token : env LIBRARIAN_ADMIN_TOKEN | legacy LIBRARIAN_AUTH_TOKEN →
//                 ${dataDir}/admin.token → generate ONLY when bound beyond localhost
//                 → null. On localhost with no token, null == the unchanged no-auth
//                 bypass; the bin keeps the fatal check for the can't-generate edge.

import fs from "node:fs";
import path from "node:path";
import { type FileIo, type LoadedSecretKey, loadOrCreateSecretKeyFile } from "../secret-crypto.js";
import { resolveSecretKey } from "../secret-crypto.js";
import { type LoadedAdminToken, loadOrCreateAdminTokenFile } from "./admin-token.js";

const SECRET_KEY_FILE = "secret.key";
const ADMIN_TOKEN_FILE = "admin.token";

export type CredentialSource = "env" | "file" | "generated" | "absent";

export interface BootCredentialSignal {
  credential: "secret-key" | "admin-token";
  source: CredentialSource;
  /** The file path involved, for `file`/`generated` sources (so the bin can log it). */
  path?: string;
}

export interface ResolvedBootCredentials {
  secretKey: Buffer | null;
  adminToken: string | null;
  signals: BootCredentialSignal[];
}

export interface BootCredentialsInput {
  env: Record<string, string | undefined>;
  dataDir: string;
  /** True when the server binds to a non-loopback host (today the fatal-without-token branch). */
  boundBeyondLocalhost: boolean;
  io?: FileIo;
}

/** Map a load helper's `generated` flag to a signal source. */
function loadedSource(generated: boolean): "generated" | "file" {
  return generated ? "generated" : "file";
}

export function resolveBootCredentials(input: BootCredentialsInput): ResolvedBootCredentials {
  const io = input.io ?? fs;
  const signals: BootCredentialSignal[] = [];

  const secretKey = resolveSecretKeyCredential(input, io, signals);
  const adminToken = resolveAdminTokenCredential(input, io, signals);
  return { secretKey, adminToken, signals };
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
  let loaded: LoadedSecretKey;
  try {
    loaded = loadOrCreateSecretKeyFile(keyPath, io);
  } catch (error) {
    // A malformed *existing* file is an operator signal — rethrow. A write failure
    // (read-only volume) means we simply can't persist a key: fall back to the
    // no-secrets path rather than crashing the whole server.
    if (io.existsSync(keyPath)) throw error;
    signals.push({ credential: "secret-key", source: "absent" });
    return null;
  }
  signals.push({ credential: "secret-key", source: loadedSource(loaded.generated), path: keyPath });
  return loaded.key;
}

function resolveAdminTokenCredential(
  input: BootCredentialsInput,
  io: FileIo,
  signals: BootCredentialSignal[],
): string | null {
  const envToken = (input.env.LIBRARIAN_ADMIN_TOKEN || input.env.LIBRARIAN_AUTH_TOKEN || "").trim();
  if (envToken) {
    signals.push({ credential: "admin-token", source: "env" });
    return envToken;
  }

  // On localhost with no env token the no-auth bypass is intentional and unchanged;
  // generating a token there would be noise. Only the bound-beyond-localhost branch
  // (today fatal without a token) auto-provisions one.
  if (!input.boundBeyondLocalhost) {
    signals.push({ credential: "admin-token", source: "absent" });
    return null;
  }

  const tokenPath = path.join(input.dataDir, ADMIN_TOKEN_FILE);
  let loaded: LoadedAdminToken;
  try {
    loaded = loadOrCreateAdminTokenFile(tokenPath, io);
  } catch (error) {
    if (io.existsSync(tokenPath)) throw error;
    // Bound beyond localhost but can't persist a token — the bin turns this into a
    // fatal (it can't run open to the network), so just report absence here.
    signals.push({ credential: "admin-token", source: "absent" });
    return null;
  }
  signals.push({
    credential: "admin-token",
    source: loadedSource(loaded.generated),
    path: tokenPath,
  });
  return loaded.token;
}
