// The dashboard→server IDENTITY ASSERTION contract (spec 065 SC 1 / SC 11).
//
// The dashboard process is TRUSTED on the internal tRPC listener (admin with no bearer,
// ADR 0008 P3). This header is NOT a credential — it is a scoping ASSERTION the trusted
// process makes about WHO a request is on behalf of: a signed-in user, or explicitly
// *nobody*. It only ever NARROWS what a request may do (a privilege drop, like `sudo -u`).
// The OSS default provider IGNORES it (byte-identical admin-by-isolation, SC 4); a
// member-aware provider maps the assertion to a member principal by SC 9's table.
//
// This module is the SERVER-SIDE reader half of the contract. The dashboard is the setter
// (its own base64url encoder, matched byte-for-byte by Node's `base64url` decode below);
// `readDashboardUser` is the ONLY thing that interprets the header, and it is the security
// boundary: everything that is not POSITIVELY one of the two SC 1 shapes is `invalid`, so
// the unclassified remainder can never drift toward `absent` (SC 11). Absence and badness are
// DIFFERENT outcomes because SC 9 routes them to OPPOSITE trust results — a helper that
// collapsed both to `null` would let an oversize or corrupt assertion resolve to admin (spec
// §7 pass 1). Hence the four-way {@link DashboardAssertion}, never a nullable.

import type { IncomingMessage } from "node:http";

/**
 * The request header carrying the dashboard's identity assertion. A browser-supplied value
 * is meaningless: the dashboard proxy STRIPS the inbound header and re-derives it from its own
 * session (spec 065 SC 1), so only the trusted process ever sets it on the wire.
 */
export const DASHBOARD_USER_HEADER = "x-librarian-dashboard-user";

/**
 * The poison marker. The SETTER sends this literal (never an omitted header, never an oversize
 * value) when it holds a browser-origin request it cannot honestly assert — a present-but-
 * unresolvable session (expired / tampered), or claims that will not encode within the cap. The
 * reader maps it to {@link DashboardAssertion} `invalid`, which SC 9 refuses. It is DISTINCT from
 * absence: a poison marker says "a browser was here and we could not vouch for it" (refuse),
 * where absence says "a machine was here" (today's isolation trust).
 */
export const DASHBOARD_USER_POISON = "invalid";

/**
 * Encoded-size ceiling (SC 1). base64url is ASCII, so the string length IS the byte length.
 * The SETTER enforces this (poison on overflow); the reader re-checks defensively — an oversize
 * value that somehow arrives is `invalid`, never a silently-accepted claim (spec §7 pass 1: an
 * oversize claims set must NOT be allowed to escalate a member to admin).
 */
export const MAX_DASHBOARD_USER_BYTES = 4096;

/**
 * A user assertion's claims (spec 065 SC 1). `provider` + `sub` are BOTH required because `sub`
 * alone is not unique across providers (GitHub and Google both mint numeric ids); the pair is the
 * stable subject a member-aware provider maps. `email` / `name` are optional display material. The
 * shape is CLOSED — see {@link readDashboardUser}.
 */
export interface DashboardUser {
  provider: string;
  sub: string;
  email?: string;
  name?: string;
}

/**
 * The four-way outcome of reading the assertion header (spec 065 SC 11). Each kind routes to a
 * DIFFERENT trust result under a member-aware provider (SC 9):
 *   - `absent`    → today's isolation trust (a machine context: the bare bootstrap client, or
 *                   module-init execution) — the ONLY fail-open row, inherited from ADR 0008 P3;
 *   - `invalid`   → refusal (the poison marker, or anything not positively one of the two shapes);
 *   - `anonymous` → refusal (or a public-only principal — provider's choice; never admin);
 *   - `user`      → mapped by subject: a known subject → its principal, an unknown one → refusal.
 */
export type DashboardAssertion =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "anonymous" }
  | { kind: "user"; user: DashboardUser };

/**
 * Read + classify the dashboard identity assertion from a request's headers. NEVER throws into
 * the context factory — every failure mode is a value, not an exception (SC 11).
 *
 * The security stance: only a header that is POSITIVELY one of SC 1's two shapes yields a
 * non-`invalid`, non-`absent` result. Absent header → `absent`. Everything else — the poison
 * marker, an oversize value, malformed base64url (duplicated headers comma-join into an invalid
 * decode), malformed JSON, a non-object payload, a decodable object matching NEITHER shape (wrong
 * types, missing required fields, a mix of both), OR an otherwise-valid shape carrying ANY
 * undeclared key (the shapes are CLOSED — the setter is ours, so strictness costs nothing) →
 * `invalid`. The unclassified remainder therefore drifts to `invalid`, never to `absent`.
 */
export function readDashboardUser(req: Pick<IncomingMessage, "headers">): DashboardAssertion {
  const raw = req.headers[DASHBOARD_USER_HEADER];
  if (raw === undefined) return { kind: "absent" };
  // Our header is single-valued; an array (Node only produces one for set-cookie) is not a shape
  // we ever set — refuse rather than guess. (Duplicated inbound values comma-JOIN into a single
  // string for ordinary headers, caught by the base64url charset check below.)
  if (typeof raw !== "string") return { kind: "invalid" };
  if (raw === DASHBOARD_USER_POISON) return { kind: "invalid" };
  if (raw.length > MAX_DASHBOARD_USER_BYTES) return { kind: "invalid" };
  // base64url alphabet only — no `+`/`/`/`=`, no whitespace, no comma. This is what rejects a
  // comma-joined duplicate header and any non-transport-safe junk before we decode.
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return { kind: "invalid" };

  let json: string;
  try {
    json = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return { kind: "invalid" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { kind: "invalid" };
  }
  return classifyClaims(parsed);
}

/**
 * Classify a decoded payload into an assertion. CLOSED-shape validation: exactly `{anon:true}`
 * for anonymous, exactly `{provider, sub, email?, name?}` (all strings, no other keys) for a
 * user. Anything else — including a valid shape with an extra key, or a mix of both shapes — is
 * `invalid`.
 */
function classifyClaims(value: unknown): DashboardAssertion {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "invalid" };
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);

  // Anonymous assertion: EXACTLY `{ anon: true }`. Any extra key, or `anon` not strictly `true`,
  // is invalid (this also rejects a mix of both shapes, e.g. `{anon:true, provider, sub}`).
  if ("anon" in obj) {
    return obj.anon === true && keys.length === 1 ? { kind: "anonymous" } : { kind: "invalid" };
  }

  // User assertion: closed to the four declared fields; provider + sub required strings.
  const allowed = new Set(["provider", "sub", "email", "name"]);
  if (!keys.every((k) => allowed.has(k))) return { kind: "invalid" };
  if (typeof obj.provider !== "string" || typeof obj.sub !== "string") return { kind: "invalid" };
  if (obj.email !== undefined && typeof obj.email !== "string") return { kind: "invalid" };
  if (obj.name !== undefined && typeof obj.name !== "string") return { kind: "invalid" };

  const user: DashboardUser = { provider: obj.provider, sub: obj.sub };
  if (obj.email !== undefined) user.email = obj.email;
  if (obj.name !== undefined) user.name = obj.name;
  return { kind: "user", user };
}
