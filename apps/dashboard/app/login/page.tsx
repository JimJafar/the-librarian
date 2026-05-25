// A1: owner sign-in page. Chrome-free (SiteNav skips /login). Two server-action
// forms, one per provider, calling Auth.js `signIn`. The single-owner allowlist
// runs in the signIn callback (auth.ts) — a non-owner who completes the OAuth
// dance is bounced back here with ?error=AccessDenied.
import { signIn } from "@/auth";
import { Button } from "@/components/ui-v2/button";

export const metadata = { title: "Sign in · Librarian" };

async function signInWith(provider: "github" | "google"): Promise<void> {
  "use server";
  await signIn(provider, { redirectTo: "/" });
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
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
        <form action={signInWith.bind(null, "github")}>
          <Button type="submit" variant="primary" className="w-full justify-center">
            Continue with GitHub
          </Button>
        </form>
        <form action={signInWith.bind(null, "google")}>
          <Button type="submit" variant="outline" className="w-full justify-center">
            Continue with Google
          </Button>
        </form>
      </div>
    </main>
  );
}
