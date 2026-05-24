// D1.3 — top-level Recall surface.
//
// Promoted from `(memories)/logs` because recall is its own thing — a
// per-query timeline with the memories returned pinned to the right.
// The old logs page stays for now and will be retired in D1.5 once the
// stranger-test confirms feature parity (per the spec's open question).

import { RecallView } from "@/components/recall/view";

export const dynamic = "force-dynamic";

export default function RecallPage() {
  return (
    <main className="flex flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Recall</h1>
      <RecallView />
    </main>
  );
}
