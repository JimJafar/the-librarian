// Dashboard auth configuration (dashboard-managed-auth, D1.4).
//
// The owner's auth setup — enabled flag, OAuth client creds, OAuth owner allowlist —
// lives in the settings table so it can change without a redeploy. OAuth client
// secrets are stored {secret:true} (encrypted at rest, reversible — the dashboard
// needs them to build providers). The password lives separately as a one-way hash
// (password.ts); this config exposes only the username, never the hash.
//
// AUTH_SECRET (the JWT signing key) is HKDF-derived from LIBRARIAN_SECRET_KEY rather
// than stored: nothing extra to persist or rotate, and rotating the master key
// rotates sessions.

import { hkdfSync } from "node:crypto";
import { type SettingsLike, hasOwnerPassword, ownerPasswordUsername } from "./password.js";

export type OAuthProvider = "github" | "google";
export type AuthMethod = "password" | OAuthProvider;

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface AuthConfig {
  enabled: boolean;
  /** Which login methods are fully configured. */
  methods: AuthMethod[];
  /** The password method's username (never the hash), or null when unset. */
  password: { username: string } | null;
  /** Decrypted OAuth client creds, per configured provider. */
  oauth: { github?: OAuthClient; google?: OAuthClient };
  /** Allowlisted owner account id per provider (for the signIn callback). */
  ownerOAuth: { github?: string; google?: string };
  /** HKDF-derived JWT secret; null when no master key is available. */
  authSecret: string | null;
}

const ENABLED_KEY = "auth:enabled";
const OAUTH_PREFIX = "auth:oauth:"; // secret JSON {clientId, clientSecret}
const OWNER_PREFIX = "auth:owner:"; // plain owner account id
const AUTH_SECRET_INFO = "dashboard-jwt-v1";
const AUTH_SECRET_BYTES = 32;
const OAUTH_PROVIDERS: OAuthProvider[] = ["github", "google"];

export function setEnabled(store: SettingsLike, enabled: boolean): void {
  store.setSetting(ENABLED_KEY, enabled ? "true" : "false");
}

export function setOAuth(store: SettingsLike, provider: OAuthProvider, client: OAuthClient): void {
  const clientId = client.clientId.trim();
  const clientSecret = client.clientSecret;
  if (!clientId || !clientSecret) throw new Error("clientId and clientSecret are required");
  store.setSetting(OAUTH_PREFIX + provider, JSON.stringify({ clientId, clientSecret }), {
    secret: true,
  });
}

export function setOwner(store: SettingsLike, provider: OAuthProvider, ownerId: string): void {
  const id = ownerId.trim();
  if (!id) throw new Error("owner id is required");
  store.setSetting(OWNER_PREFIX + provider, id);
}

/** Derive the dashboard JWT secret from the master key (stable per key). */
export function deriveAuthSecret(secretKey: Buffer | null): string | null {
  if (!secretKey) return null;
  const out = hkdfSync("sha256", secretKey, Buffer.alloc(0), AUTH_SECRET_INFO, AUTH_SECRET_BYTES);
  return Buffer.from(out).toString("hex");
}

function readOAuth(store: SettingsLike, provider: OAuthProvider): OAuthClient | undefined {
  try {
    const raw = store.getSetting(OAUTH_PREFIX + provider); // decrypts (needs the master key)
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<OAuthClient>;
    if (!parsed.clientId || !parsed.clientSecret) return undefined;
    return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
  } catch {
    // Missing key / undecryptable / malformed → treat as not configured rather than throw.
    return undefined;
  }
}

export function getAuthConfig(store: SettingsLike, secretKey: Buffer | null): AuthConfig {
  const oauth: AuthConfig["oauth"] = {};
  const ownerOAuth: AuthConfig["ownerOAuth"] = {};
  for (const provider of OAUTH_PROVIDERS) {
    const client = readOAuth(store, provider);
    if (client) oauth[provider] = client;
    const owner = store.getSetting(OWNER_PREFIX + provider);
    if (owner) ownerOAuth[provider] = owner;
  }

  const username = ownerPasswordUsername(store);
  const methods: AuthMethod[] = [];
  if (hasOwnerPassword(store)) methods.push("password");
  if (oauth.github) methods.push("github");
  if (oauth.google) methods.push("google");

  return {
    enabled: store.getSetting(ENABLED_KEY) === "true",
    methods,
    password: username ? { username } : null,
    oauth,
    ownerOAuth,
    authSecret: deriveAuthSecret(secretKey),
  };
}
