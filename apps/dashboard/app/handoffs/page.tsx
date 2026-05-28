import { HandoffsListView } from "@/components/handoffs/list-view";

export const dynamic = "force-dynamic";

export default function HandoffsPage() {
  return (
    <main className="flex flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Handoffs</h1>
      <p className="text-sm text-muted-foreground">
        Cross-harness narrative handoffs. Read-only — claim them from a coding agent with{" "}
        <code>/takeover</code>.
      </p>
      <HandoffsListView />
    </main>
  );
}
