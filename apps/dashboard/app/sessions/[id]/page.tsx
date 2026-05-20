import { notFound } from "next/navigation";
import { SessionDetailView } from "@/components/sessions/detail-view";
import type { SessionRow } from "@/components/sessions/types";
import { serverTRPC } from "@/lib/trpc-server";

export const dynamic = "force-dynamic";

export default async function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let session: SessionRow | null = null;
  let error: string | null = null;
  try {
    const result = await serverTRPC.sessions.get.query({ session_id: id });
    session = result as SessionRow;
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) notFound();
    error = err instanceof Error ? err.message : String(err);
  }
  if (!session) {
    return (
      <main className="flex flex-col gap-4 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Session</h1>
        <p className="text-sm text-destructive">Failed to load session: {error ?? "not found"}</p>
      </main>
    );
  }
  return (
    <main className="flex flex-col gap-6 p-6">
      <SessionDetailView session={session} />
    </main>
  );
}
