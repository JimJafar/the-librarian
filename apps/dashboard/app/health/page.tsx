import { serverTRPC } from "@/lib/trpc-server";

export const dynamic = "force-dynamic";

export default async function HealthPage() {
  let payload: { ok: boolean; error?: string };
  try {
    const result = await serverTRPC.health.ping.query();
    payload = result;
  } catch (err) {
    payload = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <pre className="rounded-md border bg-card p-6 font-mono text-sm text-card-foreground">
        {JSON.stringify(payload)}
      </pre>
    </main>
  );
}
