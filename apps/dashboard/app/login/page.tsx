// Owner sign-in page (A1; D3.3 made it config-driven). Chrome-free (SiteNav skips
// /login). Renders only the methods the owner has configured: a username/password
// form when a password method is set, and an OAuth button per configured provider.
// When the store has no auth config (fresh / legacy A1–A5 deploy), it falls back to
// the env-configured OAuth providers. The single-owner gate runs in auth.ts
// (signIn callback for OAuth; the store-side lockout-aware verify for password).

import { signIn } from "@/auth";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";
import { getAuthConfig } from "@/lib/auth-config-client";

export const metadata = { title: "Sign in · Librarian" };

async function signInWith(provider: "github" | "google"): Promise<void> {
  "use server";
  await signIn(provider, { redirectTo: "/" });
}

async function signInWithPassword(formData: FormData): Promise<void> {
  "use server";
  await signIn("credentials", {
    username: formData.get("username"),
    password: formData.get("password"),
    redirectTo: "/",
  });
}

async function loadConfig() {
  try {
    return await getAuthConfig();
  } catch {
    return null;
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const config = await loadConfig();
  const storeConfigured = !!config && config.methods.length > 0;

  const showPassword = storeConfigured && config.methods.includes("password");
  const showGithub = storeConfigured ? !!config.oauth?.github : !!process.env.AUTH_GITHUB_ID;
  const showGoogle = storeConfigured ? !!config.oauth?.google : !!process.env.AUTH_GOOGLE_ID;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="font-display text-2xl text-foreground">The Librarian</h1>
        <p className="text-sm text-foreground/60">Sign in to the owner dashboard.</p>
      </div>

      {error ? (
        <p className="text-sm text-ink-accent" role="alert">
          {error === "AccessDenied"
            ? "That account is not the configured owner."
            : "Sign-in failed. Please try again."}
        </p>
      ) : null}

      <div className="flex w-full max-w-xs flex-col gap-3">
        {showPassword ? (
          <form action={signInWithPassword} className="flex flex-col gap-3">
            <Input
              type="text"
              name="username"
              placeholder="Username"
              autoComplete="username"
              required
            />
            <Input
              type="password"
              name="password"
              placeholder="Password"
              autoComplete="current-password"
              required
            />
            <Button type="submit" variant="primary" className="w-full justify-center">
              Sign in
            </Button>
          </form>
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
