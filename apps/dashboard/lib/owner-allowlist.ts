// Single-owner allowlist for dashboard login (A1; D2.3 made it config-driven).
//
// The Auth.js `signIn` callback delegates the allow/deny decision here so it can be
// unit-tested without standing up NextAuth. The rule is deliberately strict: permit
// a login ONLY when the OAuth account matches a configured owner identity, and DENY
// BY DEFAULT when nothing is configured — a misconfigured deploy must never
// accidentally let an arbitrary account in.
//
// The allowlist now comes from the store auth-config (D1/D2) when present, with the
// legacy LIBRARIAN_OWNER_* env vars as the fallback (so A1–A5 deploys are untouched).
// Account ids are preferred over email (emails can change / be unverified); email is
// the documented fallback and lives only in the legacy env path.

export interface OwnerSignInInput {
  /** The OAuth provider that authenticated the user ("github" | "google"). */
  provider?: string | null;
  /** The provider account id — GitHub's numeric id or Google's `sub`. */
  accountId?: string | null;
  /** The profile email, if the provider supplied one. */
  email?: string | null;
  /**
   * Whether the provider asserts the email is verified. The email branch only
   * matches when this is true — an OAuth `email` claim is otherwise attacker-
   * controlled (e.g. an arbitrary GitHub profile email), so trusting an unverified
   * one would let anyone who knows the owner's address sign in.
   */
  emailVerified?: boolean;
}

/** A resolved owner allowlist (from store config or legacy env). */
export interface OwnerAllowlist {
  githubId?: string;
  googleId?: string;
  /** Allowlisted emails (legacy env only; matched case-insensitively, verified-only). */
  emails?: string[];
}

export interface OwnerAllowlistEnv {
  LIBRARIAN_OWNER_GITHUB_ID?: string;
  LIBRARIAN_OWNER_GOOGLE_ID?: string;
  /** Comma-separated email allowlist (matched case-insensitively). */
  LIBRARIAN_OWNER_EMAILS?: string;
}

/** The OAuth owner allowlist shape carried in the store auth-config. */
export interface OwnerOAuthConfig {
  ownerOAuth?: { github?: string; google?: string };
}

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function emailList(raw: string | undefined): string[] {
  return clean(raw)
    .toLowerCase()
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Build the allowlist from legacy LIBRARIAN_OWNER_* env vars. */
export function ownerAllowlistFromEnv(
  env: OwnerAllowlistEnv = process.env as OwnerAllowlistEnv,
): OwnerAllowlist {
  return {
    githubId: clean(env.LIBRARIAN_OWNER_GITHUB_ID),
    googleId: clean(env.LIBRARIAN_OWNER_GOOGLE_ID),
    emails: emailList(env.LIBRARIAN_OWNER_EMAILS),
  };
}

/**
 * Resolve the effective allowlist: the store config's OAuth owner ids win when set,
 * otherwise fall back to the legacy env allowlist. Config carries account ids only;
 * the email fallback remains an env-only concept.
 */
export function resolveOwnerAllowlist(
  config: OwnerOAuthConfig | null | undefined,
  env: OwnerAllowlistEnv = process.env as OwnerAllowlistEnv,
): OwnerAllowlist {
  const owner = config?.ownerOAuth;
  if (owner && (clean(owner.github) || clean(owner.google))) {
    return { githubId: clean(owner.github), googleId: clean(owner.google) };
  }
  return ownerAllowlistFromEnv(env);
}

export function isAllowedOwner(input: OwnerSignInInput, allowlist: OwnerAllowlist): boolean {
  const githubId = clean(allowlist.githubId);
  const googleId = clean(allowlist.googleId);
  const emails = (allowlist.emails ?? []).map((e) => e.toLowerCase().trim()).filter(Boolean);

  // Deny by default: with no owner configured, no one is the owner.
  if (!githubId && !googleId && emails.length === 0) return false;

  const provider = clean(input.provider).toLowerCase();
  const accountId = clean(input.accountId);
  const email = clean(input.email).toLowerCase();

  if (provider === "github" && githubId && accountId === githubId) return true;
  if (provider === "google" && googleId && accountId === googleId) return true;
  // Email is a fallback and only honored when the provider verified it.
  if (input.emailVerified && email && emails.includes(email)) return true;

  return false;
}
