import "server-only";

const MAX_TOKEN_CHARS = 8_192;
const SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Decode the claimed email for display only. This deliberately has no secret and
 * performs no MAC/expiry validation; redemption re-derives the authoritative email
 * from the server-verified token.
 */
export function displayEmailFromClaimToken(token: string): string | null {
  if (!token || token.length > MAX_TOKEN_CHARS) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const payloadSegment = parts[1];
  if (!payloadSegment || !SEGMENT.test(payloadSegment)) return null;

  try {
    const payload = Buffer.from(payloadSegment, "base64url");
    if (payload.toString("base64url") !== payloadSegment) return null;
    const decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(payload),
    ) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    const claim = decoded as Record<string, unknown>;
    if (claim.v !== 1 || claim.purpose !== "bootstrap-claim") return null;
    if (typeof claim.email !== "string" || claim.email.length > 320 || !claim.email.includes("@")) {
      return null;
    }
    return claim.email;
  } catch {
    return null;
  }
}
