// One-shot first-owner bootstrap claims (spec 070).
//
// A provisioner and the Librarian share one high-entropy secret. The provisioner
// signs a short-lived email claim; the server verifies it, creates the owner, and
// burns the ceremony into a data-dir sidecar. The token is deliberately small and
// purpose-specific rather than a general JWT surface.

import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isAuthUnowned } from "./auth-config.js";
import type { SettingsLike } from "./password.js";

export const BOOTSTRAP_CLAIM_FILENAME = "bootstrap-claim.json";
export const BOOTSTRAP_CLAIM_MAX_TTL_MS = 24 * 60 * 60_000;
export const BOOTSTRAP_CLAIM_MIN_SECRET_LENGTH = 32;

const TOKEN_PREFIX = "v1";
const TOKEN_SEGMENT = /^[A-Za-z0-9_-]+$/;

const EmailSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .email()
  .transform((email) => email.toLowerCase());

const BootstrapClaimSchema = z
  .object({
    v: z.literal(1),
    purpose: z.literal("bootstrap-claim"),
    email: EmailSchema,
    exp: z.number().int().positive(),
    returnTo: z.string().max(2048).optional(),
  })
  .strict();

const BootstrapClaimReceiptSchema = z
  .object({
    v: z.literal(1),
    purpose: z.literal("claim-receipt"),
    email: EmailSchema,
    claimedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  })
  .strict();

const BootstrapClaimBurnSchema = z
  .object({
    claimedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
    email: EmailSchema,
  })
  .strict();

export type BootstrapClaim = z.infer<typeof BootstrapClaimSchema>;
export type BootstrapClaimReceipt = z.infer<typeof BootstrapClaimReceiptSchema>;
export type BootstrapClaimBurn = z.infer<typeof BootstrapClaimBurnSchema>;

export interface MintBootstrapClaimInput {
  email: string;
  expiresAt: Date;
  returnTo?: string;
}

export interface MintBootstrapClaimReceiptInput {
  email: string;
  claimedAt: string;
}

export type BootstrapClaimTokenErrorCode = "invalid" | "expired";

export class BootstrapClaimTokenError extends Error {
  readonly code: BootstrapClaimTokenErrorCode;

  constructor(code: BootstrapClaimTokenErrorCode) {
    super(code === "expired" ? "claim expired" : "claim invalid");
    this.name = "BootstrapClaimTokenError";
    this.code = code;
  }
}

export interface BootstrapClaimHandle {
  readonly armed: boolean;
  isBurned(): boolean;
  claimPending(store: SettingsLike): boolean;
  verify(token: string, now?: Date): BootstrapClaim;
  burn(email: string, now?: Date): BootstrapClaimBurn;
  mintReceipt(input: MintBootstrapClaimReceiptInput): string;
}

export interface CreateBootstrapClaimHandleInput {
  dataDir: string;
  secret: string;
}

export function assertBootstrapClaimSecret(secret: string): void {
  if (secret.length < BOOTSTRAP_CLAIM_MIN_SECRET_LENGTH) {
    throw new Error(
      `LIBRARIAN_BOOTSTRAP_CLAIM_SECRET must be at least ${BOOTSTRAP_CLAIM_MIN_SECRET_LENGTH} characters`,
    );
  }
}

function invalidClaim(): BootstrapClaimTokenError {
  return new BootstrapClaimTokenError("invalid");
}

function parseEmail(email: string): string {
  const parsed = EmailSchema.safeParse(email);
  if (!parsed.success) throw invalidClaim();
  return parsed.data;
}

function signBytes(secret: string, bytes: Buffer): string {
  return createHmac("sha256", secret).update(bytes).digest("base64url");
}

function mintToken(secret: string, claims: BootstrapClaim | BootstrapClaimReceipt): string {
  assertBootstrapClaimSecret(secret);
  const bytes = Buffer.from(JSON.stringify(claims));
  const payload = bytes.toString("base64url");
  return `${TOKEN_PREFIX}.${payload}.${signBytes(secret, bytes)}`;
}

function decodeCanonicalSegment(segment: string): Buffer {
  if (!TOKEN_SEGMENT.test(segment)) throw invalidClaim();
  const decoded = Buffer.from(segment, "base64url");
  if (decoded.length === 0 || decoded.toString("base64url") !== segment) throw invalidClaim();
  return decoded;
}

function verifiedPayload(secret: string, token: string): unknown {
  assertBootstrapClaimSecret(secret);
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) throw invalidClaim();
  const payloadSegment = parts[1];
  const macSegment = parts[2];
  if (payloadSegment === undefined || macSegment === undefined) throw invalidClaim();

  const payload = decodeCanonicalSegment(payloadSegment);
  const presentedMac = decodeCanonicalSegment(macSegment);
  const expectedMac = createHmac("sha256", secret).update(payload).digest();
  if (presentedMac.length !== expectedMac.length || !timingSafeEqual(presentedMac, expectedMac)) {
    throw invalidClaim();
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as unknown;
  } catch {
    throw invalidClaim();
  }
}

export function mintBootstrapClaim(
  secret: string,
  input: MintBootstrapClaimInput,
  now: Date = new Date(),
): string {
  const exp = Math.floor(input.expiresAt.getTime() / 1000);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (
    !Number.isFinite(exp) ||
    exp <= nowSeconds ||
    input.expiresAt.getTime() - now.getTime() > BOOTSTRAP_CLAIM_MAX_TTL_MS
  ) {
    throw invalidClaim();
  }

  const parsed = BootstrapClaimSchema.safeParse({
    v: 1,
    purpose: "bootstrap-claim",
    email: input.email,
    exp,
    ...(input.returnTo === undefined ? {} : { returnTo: input.returnTo }),
  });
  if (!parsed.success) throw invalidClaim();
  return mintToken(secret, parsed.data);
}

export function verifyBootstrapClaim(
  secret: string,
  token: string,
  now: Date = new Date(),
): BootstrapClaim {
  const parsed = BootstrapClaimSchema.safeParse(verifiedPayload(secret, token));
  if (!parsed.success) throw invalidClaim();

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (parsed.data.exp <= nowSeconds) throw new BootstrapClaimTokenError("expired");
  if (parsed.data.exp - nowSeconds > BOOTSTRAP_CLAIM_MAX_TTL_MS / 1000) {
    throw invalidClaim();
  }
  return parsed.data;
}

export function mintBootstrapClaimReceipt(
  secret: string,
  input: MintBootstrapClaimReceiptInput,
): string {
  const parsed = BootstrapClaimReceiptSchema.safeParse({
    v: 1,
    purpose: "claim-receipt",
    email: input.email,
    claimedAt: input.claimedAt,
  });
  if (!parsed.success) throw invalidClaim();
  return mintToken(secret, parsed.data);
}

export function verifyBootstrapClaimReceipt(secret: string, token: string): BootstrapClaimReceipt {
  const parsed = BootstrapClaimReceiptSchema.safeParse(verifiedPayload(secret, token));
  if (!parsed.success) throw invalidClaim();
  return parsed.data;
}

function burnPath(dataDir: string): string {
  return path.join(dataDir, BOOTSTRAP_CLAIM_FILENAME);
}

export function isBootstrapClaimBurned(dataDir: string): boolean {
  return fs.existsSync(burnPath(dataDir));
}

export function readBootstrapClaimBurn(dataDir: string): BootstrapClaimBurn | null {
  try {
    const parsed = BootstrapClaimBurnSchema.safeParse(
      JSON.parse(fs.readFileSync(burnPath(dataDir), "utf8")) as unknown,
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function burnBootstrapClaim(
  dataDir: string,
  email: string,
  now: Date = new Date(),
): BootstrapClaimBurn {
  const parsed = BootstrapClaimBurnSchema.safeParse({
    claimedAt: now.toISOString(),
    email: parseEmail(email),
  });
  if (!parsed.success) throw invalidClaim();

  fs.mkdirSync(dataDir, { recursive: true });
  const file = fs.openSync(burnPath(dataDir), "wx", 0o600);
  try {
    fs.writeFileSync(file, `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
  } finally {
    fs.closeSync(file);
  }
  return parsed.data;
}

export function createBootstrapClaimHandle(
  input: CreateBootstrapClaimHandleInput,
): BootstrapClaimHandle {
  assertBootstrapClaimSecret(input.secret);
  return {
    armed: true,
    isBurned: () => isBootstrapClaimBurned(input.dataDir),
    claimPending: (store) => !isBootstrapClaimBurned(input.dataDir) && isAuthUnowned(store),
    verify: (token, now) => verifyBootstrapClaim(input.secret, token, now),
    burn: (email, now) => burnBootstrapClaim(input.dataDir, email, now),
    mintReceipt: (receipt) => mintBootstrapClaimReceipt(input.secret, receipt),
  };
}

export function createInertBootstrapClaimHandle(): BootstrapClaimHandle {
  return {
    armed: false,
    isBurned: () => false,
    claimPending: () => false,
    verify: () => {
      throw invalidClaim();
    },
    burn: () => {
      throw invalidClaim();
    },
    mintReceipt: () => {
      throw invalidClaim();
    },
  };
}
