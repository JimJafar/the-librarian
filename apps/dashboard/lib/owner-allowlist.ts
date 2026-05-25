// A1: single-owner allowlist for dashboard login.
//
// The Auth.js `signIn` callback delegates the allow/deny decision here so it can
// be unit-tested without standing up NextAuth. The rule is deliberately strict:
// permit a login ONLY when the OAuth account matches a configured owner identity,
// and DENY BY DEFAULT when nothing is configured — a misconfigured deploy must
// never accidentally let an arbitrary account in.
//
// Match precedence (any one is sufficient): GitHub account id, Google account id
// (the OIDC `sub`), or an allowlisted email from any provider. Account ids are
// preferred over email (emails can change / be unverified); email is the
// documented fallback.

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
   * controlled (e.g. an arbitrary GitHub profile email), so trusting an
   * unverified one would let anyone who knows the owner's address sign in.
   */
  emailVerified?: boolean;
}

export interface OwnerAllowlistEnv {
  LIBRARIAN_OWNER_GITHUB_ID?: string;
  LIBRARIAN_OWNER_GOOGLE_ID?: string;
  /** Comma-separated email allowlist (matched case-insensitively). */
  LIBRARIAN_OWNER_EMAILS?: string;
}

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function emailAllowlist(raw: string | undefined): string[] {
  return clean(raw)
    .toLowerCase()
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function isAllowedOwner(
  input: OwnerSignInInput,
  env: OwnerAllowlistEnv = process.env as OwnerAllowlistEnv,
): boolean {
  const githubId = clean(env.LIBRARIAN_OWNER_GITHUB_ID);
  const googleId = clean(env.LIBRARIAN_OWNER_GOOGLE_ID);
  const emails = emailAllowlist(env.LIBRARIAN_OWNER_EMAILS);

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
