import { LogsView } from "@/components/memories/logs-view";

export const dynamic = "force-dynamic";

export default function LogsPage() {
  return (
    <main className="flex flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Logs</h1>
      <LogsView />
    </main>
  );
}
