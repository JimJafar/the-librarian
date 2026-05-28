import { HandoffDetailView } from "@/components/handoffs/detail-view";

export const dynamic = "force-dynamic";

export default async function HandoffDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="flex flex-col gap-4 p-6">
      <HandoffDetailView handoffId={id} />
    </main>
  );
}
