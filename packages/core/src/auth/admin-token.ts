// Bootstrap admin token file (dashboard-managed-auth, D0).
//
// The admin token authenticates the dashboard→store tRPC proxy. Today it must be
// supplied via LIBRARIAN_ADMIN_TOKEN; D0 lets a fresh install auto-generate one to
// the data volume (printed once) so a bound-beyond-localhost deploy is secured with
// zero env surgery. Env still wins when set.
//
// Token shape: `libadmin_<base64url>` (a prefix that makes it greppable/recognizable
// in logs and config; base64url body of >=32 random bytes). It's a bearer secret, so
// the file is written 0600 and the value is never logged except the one-time
// generation notice in the boot path.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import type { FileIo } from "../secret-crypto.js";

const TOKEN_PREFIX = "libadmin_";
const ENTROPY_BYTES = 32;

export interface LoadedAdminToken {
  token: string;
  /** True when this call generated a fresh token (caller prints the one-time notice). */
  generated: boolean;
}

/**
 * Validate the `libadmin_<base64url>` shape and that the body carries the required
 * entropy. Returns the token on success; throws on a malformed value so a corrupt
 * token file is an operator signal rather than silently treated as "no token".
 */
export function parseAdminToken(raw: string): string {
  const token = raw.trim();
  if (!token.startsWith(TOKEN_PREFIX)) {
    throw new Error(`malformed admin token (expected '${TOKEN_PREFIX}<base64url>')`);
  }
  const body = token.slice(TOKEN_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) {
    throw new Error("malformed admin token (body is not base64url)");
  }
  if (Buffer.from(body, "base64url").length < ENTROPY_BYTES) {
    throw new Error(`malformed admin token (needs >=${ENTROPY_BYTES} bytes of entropy)`);
  }
  return token;
}

/**
 * Read the admin token from `filePath`, or generate and persist one when absent.
 *
 * - Exists → read + validate the shape (throws on a malformed file rather than
 *   overwriting it). Perms are left as-is (never widened).
 * - Absent → write `libadmin_<base64url>` (>=32 random bytes) with
 *   `open('wx', 0o600)`: race-safe creation, owner-only from the first byte.
 */
export function loadOrCreateAdminTokenFile(filePath: string, io: FileIo = fs): LoadedAdminToken {
  if (io.existsSync(filePath)) {
    return { token: parseAdminToken(io.readFileSync(filePath, "utf8")), generated: false };
  }
  const token = `${TOKEN_PREFIX}${randomBytes(ENTROPY_BYTES).toString("base64url")}`;
  io.writeFileSync(filePath, token, { flag: "wx", mode: 0o600 });
  return { token, generated: true };
}
