import { SessionsListView } from "@/components/sessions/list-view";

export const dynamic = "force-dynamic";

export default function SessionsPage() {
  return (
    <main className="flex flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
      <SessionsListView />
    </main>
  );
}
