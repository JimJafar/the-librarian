// D4.3: one-time-link password reset. Reached by a locked-out owner with NO session
// — this route is excluded from the auth middleware, so the link token (single-use,
// short-TTL, validated store-side) is the credential. Chrome-free, like /login.

import { ResetForm } from "@/components/settings/auth/reset-form";

export const metadata = { title: "Reset password · Librarian" };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="font-display text-2xl text-foreground">Reset password</h1>
        <p className="text-sm text-foreground/60">
          Set a new owner password using your one-time link.
        </p>
      </div>

      {token ? (
        <ResetForm token={token} />
      ) : (
        <p className="text-sm text-ink-accent" role="alert">
          This reset link is missing its token. Generate a fresh one with{" "}
          <code>the-librarian auth reset-password --print-setup-link</code>.
        </p>
      )}
    </main>
  );
}
