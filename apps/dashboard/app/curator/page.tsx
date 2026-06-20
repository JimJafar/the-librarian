// Curator chat workspace (spec 044 D-7). One job: discuss the corpus and
// the curator's running addendum, propose fixes, confirm them inline.
//
// The configuration side — LLM providers, intake config + runs, grooming
// config + runs — lives at /settings/curator. That keeps this page a
// chat-first surface (the thing the operator actually uses day to day)
// and pushes the rare-touch knobs into Settings.

import Link from "next/link";
import {
  chatAction,
  confirmActionAction,
  rollbackAddendumAction,
  setAddendumAction,
} from "@/app/curator/actions";
import { GroomingChatWorkspace } from "@/components/curator/chat-workspace";
import { serverTRPC } from "@/lib/trpc-server";

export const dynamic = "force-dynamic";

export default async function CuratorPage() {
  let groomingAddendum: Awaited<ReturnType<typeof serverTRPC.addendum.get.query>> | null = null;
  let intakeAddendum: Awaited<ReturnType<typeof serverTRPC.addendum.get.query>> | null = null;
  let groomingPrompt: Awaited<ReturnType<typeof serverTRPC.addendum.getBasePrompt.query>> | null =
    null;
  let intakePrompt: Awaited<ReturnType<typeof serverTRPC.addendum.getBasePrompt.query>> | null =
    null;
  let error: string | null = null;
  try {
    [groomingAddendum, intakeAddendum, groomingPrompt, intakePrompt] = await Promise.all([
      serverTRPC.addendum.get.query({ job: "grooming" }),
      serverTRPC.addendum.get.query({ job: "intake" }),
      serverTRPC.addendum.getBasePrompt.query({ job: "grooming" }),
      serverTRPC.addendum.getBasePrompt.query({ job: "intake" }),
    ]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="flex flex-col gap-5 p-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-xl text-foreground">Memory Curator</h1>
        <p className="text-sm text-foreground/60">
          Discuss the corpus with the curator and teach it via the addendum. Proposed fixes apply
          only when you confirm them — nothing runs automatically.{" "}
          <Link
            href="/settings/curator"
            className="text-ink-accent underline-offset-2 hover:underline"
          >
            Configure curator →
          </Link>
        </p>
      </header>

      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {groomingAddendum && intakeAddendum && groomingPrompt && intakePrompt ? (
        <GroomingChatWorkspace
          jobs={{
            grooming: {
              content: groomingAddendum.content,
              version: groomingAddendum.version,
              basePrompt: groomingPrompt.basePrompt,
              promptVersion: groomingPrompt.version,
            },
            intake: {
              content: intakeAddendum.content,
              version: intakeAddendum.version,
              basePrompt: intakePrompt.basePrompt,
              promptVersion: intakePrompt.version,
            },
          }}
          actions={{
            onChat: chatAction,
            onConfirmAction: confirmActionAction,
            onSetAddendum: setAddendumAction,
            onRollback: rollbackAddendumAction,
          }}
        />
      ) : null}
    </main>
  );
}
