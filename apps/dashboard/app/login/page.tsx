// Owner sign-in page (A1; D3.3 made it config-driven). Chrome-free (SiteNav
// skips /login). Renders only the methods the owner has configured: a
// username/password form when a password method is set, and an OAuth button
// per configured provider. When the store has no auth config (fresh / legacy
// A1–A5 deploy), it falls back to the env-configured OAuth providers. The
// single-owner gate runs in auth.ts (signIn callback for OAuth; the
// store-side lockout-aware verify for password).

import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { signIn } from "@/auth";
import { LibrarianMark } from "@/components/brand/librarian-mark";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";
import { SectionLabel } from "@/components/ui-v2/section-label";
import { getAuthConfigSafe } from "@/lib/auth-config-client";

export const metadata = { title: "Sign in · Librarian" };

async function signInWith(provider: "github" | "google"): Promise<void> {
  "use server";
  await signIn(provider, { redirectTo: "/" });
}

async function signInWithPassword(formData: FormData): Promise<void> {
  "use server";
  try {
    await signIn("credentials", {
      username: formData.get("username"),
      password: formData.get("password"),
      redirectTo: "/",
    });
  } catch (error) {
    // A failed/locked credentials sign-in throws an AuthError → back to /login
    // with a generic error (no lockout / user-enumeration). Success throws
    // NEXT_REDIRECT, which must propagate, so only AuthError is handled here.
    if (error instanceof AuthError) redirect("/login?error=CredentialsSignin");
    throw error;
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const config = await getAuthConfigSafe();
  const storeConfigured = !!config && config.methods.length > 0;

  const showPassword = storeConfigured && config.methods.includes("password");
  const showGithub = storeConfigured ? !!config.oauth?.github : !!process.env.AUTH_GITHUB_ID;
  const showGoogle = storeConfigured ? !!config.oauth?.google : !!process.env.AUTH_GOOGLE_ID;
  const showOAuth = showGithub || showGoogle;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-6">
      <div className="flex flex-col items-center gap-4 text-center">
        <LibrarianMark size="rail" />
        <div className="flex flex-col items-center gap-1.5">
          <h1 className="font-display text-xl text-foreground">The Librarian</h1>
          <p className="text-sm text-foreground/60">Sign in to the owner dashboard.</p>
        </div>
      </div>

      {error ? (
        <p
          role="alert"
          className="w-full max-w-xs border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          {error === "AccessDenied"
            ? "That account is not the configured owner."
            : "Sign-in failed. Please try again."}
        </p>
      ) : null}

      <div className="flex w-full max-w-xs flex-col gap-5">
        {showPassword ? (
          <form action={signInWithPassword} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <SectionLabel as="label" htmlFor="login-username">
                Username
              </SectionLabel>
              <Input
                id="login-username"
                type="text"
                name="username"
                autoComplete="username"
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <SectionLabel as="label" htmlFor="login-password">
                Password
              </SectionLabel>
              <Input
                id="login-password"
                type="password"
                name="password"
                autoComplete="current-password"
                required
              />
            </div>
            <Button type="submit" variant="primary" className="w-full justify-center">
              Sign in
            </Button>
          </form>
        ) : null}

        {showPassword && showOAuth ? (
          <div className="relative flex items-center justify-center">
            <span className="absolute inset-x-0 top-1/2 h-px bg-ink-hairline" aria-hidden />
            <span className="relative bg-background px-3 font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-foreground/60">
              or
            </span>
          </div>
        ) : null}

        {showGithub ? (
          <form action={signInWith.bind(null, "github")}>
            <Button type="submit" variant="outline" className="w-full justify-center">
              Continue with GitHub
            </Button>
          </form>
        ) : null}
        {showGoogle ? (
          <form action={signInWith.bind(null, "google")}>
            <Button type="submit" variant="outline" className="w-full justify-center">
              Continue with Google
            </Button>
          </form>
        ) : null}
      </div>
    </main>
  );
}
