import { LibrarianMark } from "@/components/brand/librarian-mark";
import { ClaimForm } from "@/components/claim/claim-form";
import { getAuthConfigSafe } from "@/lib/auth-config-client";
import { displayEmailFromClaimToken } from "@/lib/claim-token-display";

export const metadata = { title: "Claim owner account · Librarian" };

function ClaimNotice({
  role,
  title,
  children,
}: {
  role: "alert" | "status";
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role={role}
      className="flex w-full max-w-sm flex-col gap-2 border border-ink-hairline bg-ink-surface/50 p-4 text-sm"
    >
      <h2 className="font-display text-base text-foreground">{title}</h2>
      <div className="leading-relaxed text-foreground/70">{children}</div>
    </div>
  );
}

export default async function ClaimPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  const config = await getAuthConfigSafe();
  const email = token ? displayEmailFromClaimToken(token) : null;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-6">
      <div className="flex flex-col items-center gap-4 text-center">
        <LibrarianMark size="rail" />
        <div className="flex max-w-sm flex-col items-center gap-1.5">
          <h1 className="font-display text-xl text-foreground">Claim this Librarian</h1>
          <p className="text-sm leading-relaxed text-foreground/60">
            Create the first owner account and close the unauthenticated setup window.
          </p>
        </div>
      </div>

      {config === null ? (
        <ClaimNotice role="alert" title="Claim status is unavailable">
          <p>The Librarian cannot confirm whether this claim is armed. It is refusing safely.</p>
          <a
            href="/claim"
            className="mt-2 inline-block text-ink-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
          >
            Retry claim status →
          </a>
        </ClaimNotice>
      ) : !config.claimPending ? (
        <ClaimNotice role="status" title="Claiming is not available">
          This instance is not armed for a first-owner claim, has already been claimed, or has auth
          enabled. Ask the operator for the current access path.
        </ClaimNotice>
      ) : !email ? (
        <ClaimNotice role="alert" title="This claim link is missing or malformed">
          Request a fresh claim link from the person or service that provisioned this Librarian.
        </ClaimNotice>
      ) : (
        <ClaimForm token={token} email={email} />
      )}
    </main>
  );
}
