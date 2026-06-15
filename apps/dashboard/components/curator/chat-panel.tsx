"use client";

import type { ChatJob, ChatResponse, ProposedAction } from "@librarian/core";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useState, useTransition } from "react";
import { humaniseAction } from "./humanise-action";
import type { AddendumStateResult, ChatResult, ConfirmActionResult } from "@/app/curator/actions";
import { MemoryOrb } from "@/components/brand/memory-orb";
import { Button } from "@/components/ui-v2/button";
import { Hairline } from "@/components/ui-v2/hairline";
import { SectionLabel } from "@/components/ui-v2/section-label";

// Curator chat panel (spec 044 D-7 / decisions D-5/6/9/11) — rebuilt onto
// the editorial system (Phase 4).
//
// The conversation reads as a typographic transcript: role marker above
// each turn (YOU / CURATOR / SYSTEM) in mono small-caps, body in
// Newsreader prose, hairline dividers between turns. No bubbles, no
// alternating bg fills.
//
// Three response kinds from `ChatResponse`:
//   - message        → assistant text, rendered as a CURATOR turn.
//   - proposed_action → renders as the ProposedActionCard: one-line
//     intent gloss, payload behind a <details> disclosure, Skip + Confirm.
//     Confirm wears the destructive variant for irreversible actions
//     (merge / unmerge). The chat NEVER auto-runs; the admin confirms.
//   - addendum_edit  → populates the right-pane addendum draft with the
//     candidate text; `over_limit` warns inline. The transcript gets a
//     CURATOR note pointing the operator at the addendum editor.
//
// A live byte counter sits under the addendum textarea, so the operator
// sees they're approaching the 2 KB write-side cap before submitting.
// Commit is disabled when over-limit.

const ADDENDUM_LIMIT = 2048;
const ADDENDUM_WARN = 1638; // 80% of the cap

type Role = "system" | "user" | "assistant";
interface ChatMessage {
  role: Role;
  content: string;
}

type EntryStatus = "pending" | "skipped" | "confirmed" | "failed";

interface ActionEntry {
  kind: "action";
  action: ProposedAction;
  status: EntryStatus;
  outcome: string | null;
}

type Entry = { kind: "text"; role: "user" | "assistant" | "system"; text: string } | ActionEntry;

const EXAMPLE_PROMPTS: Record<ChatJob, readonly string[]> = {
  grooming: [
    "What memories duplicate each other?",
    "Why was the last grooming run skipped?",
    "Draft an addendum to reduce false-positive flags.",
  ],
  intake: [
    "What's in the inbox right now?",
    "Why did the last intake skip these submissions?",
    "Draft an addendum to teach the intake curator about my project naming.",
  ],
};

const ROLE_LABEL: Record<"user" | "assistant" | "system", string> = {
  user: "You",
  assistant: "Curator",
  system: "System",
};

export function ChatPanel({
  onChat,
  onConfirmAction,
  onSetAddendum,
  memoryId,
  memoryTitle,
  job = "grooming",
  initialAddendum = "",
  draft: controlledDraft,
  onDraftChange,
}: {
  onChat: (input: {
    messages: ChatMessage[];
    memoryId?: string;
    job?: ChatJob;
  }) => Promise<ChatResult>;
  onConfirmAction: (action: ProposedAction) => Promise<ConfirmActionResult>;
  onSetAddendum: (input: { job: ChatJob; content: string }) => Promise<AddendumStateResult>;
  memoryId?: string;
  memoryTitle?: string;
  job?: ChatJob;
  initialAddendum?: string;
  draft?: string;
  onDraftChange?: (next: string) => void;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [internalDraft, setInternalDraft] = useState(initialAddendum);
  const draft = controlledDraft ?? internalDraft;
  const setDraft = (next: string) => {
    if (onDraftChange) onDraftChange(next);
    else setInternalDraft(next);
  };
  const [addendumStatus, setAddendumStatus] = useState<string | null>(null);
  const [addendumError, setAddendumError] = useState<string | null>(null);
  const [committing, startCommit] = useTransition();

  useEffect(() => {
    if (!addendumStatus) return;
    const id = window.setTimeout(() => setAddendumStatus(null), 5000);
    return () => window.clearTimeout(id);
  }, [addendumStatus]);

  const draftBytes = new Blob([draft]).size;
  const draftWarn = draftBytes >= ADDENDUM_WARN && draftBytes <= ADDENDUM_LIMIT;
  const draftOver = draftBytes > ADDENDUM_LIMIT;

  const send = (content: string) => {
    if (!content || pending) return;
    const next = [...messages, { role: "user" as const, content }];
    setMessages(next);
    setEntries((e) => [...e, { kind: "text", role: "user", text: content }]);
    setInput("");
    setChatError(null);
    startTransition(async () => {
      const res = await onChat({
        messages: next,
        ...(memoryId ? { memoryId } : {}),
        job,
      });
      if (!res.ok) {
        setChatError(res.error);
        return;
      }
      applyResponse(res.response, next);
    });
  };

  const sendCurrent = () => send(input.trim());

  const applyResponse = (response: ChatResponse, sent: ChatMessage[]) => {
    switch (response.kind) {
      case "message":
        setMessages([...sent, { role: "assistant", content: response.text }]);
        setEntries((e) => [...e, { kind: "text", role: "assistant", text: response.text }]);
        break;
      case "proposed_action":
        setMessages([...sent, { role: "assistant", content: JSON.stringify(response) }]);
        setEntries((e) => [
          ...e,
          { kind: "action", action: response.action, status: "pending", outcome: null },
        ]);
        break;
      case "addendum_edit":
        setMessages([...sent, { role: "assistant", content: JSON.stringify(response) }]);
        setDraft(response.candidate);
        setAddendumStatus(null);
        setEntries((e) => [
          ...e,
          {
            kind: "text",
            role: "assistant",
            text:
              response.over_limit === true
                ? "I've drafted addendum guidance — it's still over 2 KB. Trim it in the editor on the right before committing."
                : "I've drafted addendum guidance — review it in the editor on the right.",
          },
        ]);
        break;
    }
  };

  const skip = (index: number) =>
    setEntries((e) =>
      e.map((entry, i) =>
        i === index && entry.kind === "action" ? { ...entry, status: "skipped" } : entry,
      ),
    );

  const confirm = (index: number, action: ProposedAction) =>
    startTransition(async () => {
      const res = await onConfirmAction(action);
      const { verb } = humaniseAction(action);
      setEntries((e) =>
        e.map((entry, i) =>
          i === index && entry.kind === "action"
            ? res.ok
              ? {
                  ...entry,
                  status: "confirmed",
                  outcome: `Confirmed — the ${verb} was applied.`,
                }
              : { ...entry, status: "failed", outcome: res.error }
            : entry,
        ),
      );
      if (res.ok) router.refresh();
    });

  const commitAddendum = () =>
    startCommit(async () => {
      setAddendumError(null);
      const res = await onSetAddendum({ job, content: draft });
      if (res.ok) {
        setAddendumStatus(`Committed — applies on the next ${job} run.`);
        router.refresh();
      } else {
        setAddendumError(res.error);
      }
    });

  return (
    <section
      className="grid gap-8 border border-ink-hairline bg-ink-surface p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-10"
      aria-label="Curator chat"
    >
      {/* --- Conversation (left) --------------------------------------------- */}
      <div className="flex min-w-0 flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h3 className="font-display text-base text-foreground">Chat with the curator</h3>
          {memoryId ? (
            <p className="text-xs text-foreground/60">
              Grounded in {memoryTitle ? <strong>{memoryTitle}</strong> : "memory"} (
              <code className="font-mono text-foreground/80">{memoryId}</code>)
            </p>
          ) : (
            <p className="text-xs text-foreground/60">
              General {job} conversation — no specific memory.
            </p>
          )}
        </header>

        {entries.length === 0 ? (
          <EmptyState job={job} disabled={pending} onPick={(prompt) => send(prompt)} />
        ) : null}

        {entries.length > 0 ? (
          <ol className="flex flex-col" aria-label="Conversation">
            {entries.map((entry, i) => (
              <Fragment key={i}>
                {i > 0 ? <Hairline className="my-4" /> : null}
                <li>
                  {entry.kind === "text" ? (
                    <TextTurn role={entry.role} text={entry.text} />
                  ) : (
                    <ProposedActionCard
                      action={entry.action}
                      status={entry.status}
                      outcome={entry.outcome}
                      disabled={pending}
                      onSkip={() => skip(i)}
                      onConfirm={() => confirm(i, entry.action)}
                    />
                  )}
                </li>
              </Fragment>
            ))}
            {pending ? (
              <Fragment>
                <Hairline className="my-4" />
                <li aria-live="polite">
                  <div className="flex items-center gap-2">
                    <SectionLabel as="div">Curator</SectionLabel>
                    <MemoryOrb size={10} pulse />
                  </div>
                </li>
              </Fragment>
            ) : null}
          </ol>
        ) : null}

        {chatError ? (
          <p
            role="alert"
            className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
          >
            {chatError}
          </p>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <SectionLabel as="label" htmlFor="curator-message">
            Message the curator
          </SectionLabel>
          <textarea
            id="curator-message"
            aria-label="Message the curator"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                sendCurrent();
              }
            }}
            placeholder="Ask the curator…"
            className="min-h-[60px] border border-ink-hairline bg-ink-mono-fill p-2 font-sans text-sm leading-relaxed text-foreground placeholder:text-foreground/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-accent"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-foreground/55">
              <kbd className="font-mono">⌘↵</kbd> to send
            </span>
            <Button
              type="button"
              variant="primary"
              onClick={sendCurrent}
              disabled={pending || input.trim() === ""}
            >
              {pending ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
      </div>

      {/* --- Addendum draft (right) ------------------------------------------ */}
      <div className="flex min-w-0 flex-col gap-4 border-t border-ink-hairline pt-6 lg:border-l lg:border-t-0 lg:pl-10 lg:pt-0">
        <header className="flex flex-col gap-1">
          <h3 className="font-display text-base text-foreground">Addendum ({job})</h3>
          <p className="text-xs text-foreground/60">
            Operator guidance for the {job} curator. Committed addenda apply on the job's next run.
          </p>
        </header>

        <div className="flex flex-col gap-1.5">
          <SectionLabel as="label" htmlFor="curator-addendum">
            Addendum draft
          </SectionLabel>
          <textarea
            id="curator-addendum"
            aria-label="Addendum draft"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setAddendumError(null);
              setAddendumStatus(null);
            }}
            placeholder="The curator's addendum suggestions appear here — or write your own."
            className="min-h-[200px] flex-1 border border-ink-hairline bg-ink-mono-fill p-3 font-mono text-xs leading-relaxed text-foreground placeholder:text-foreground/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-accent"
          />
          <p
            className={
              draftOver
                ? "text-xs text-destructive"
                : draftWarn
                  ? "text-xs text-foreground"
                  : "text-xs text-foreground/55"
            }
            aria-live="polite"
          >
            {draftBytes.toLocaleString()} / {ADDENDUM_LIMIT.toLocaleString()} bytes
            {draftOver ? " — shorten below 2 KB to commit" : null}
          </p>
        </div>

        {addendumError ? (
          <p
            role="alert"
            className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
          >
            {addendumError}
          </p>
        ) : null}
        {addendumStatus ? (
          <p
            role="status"
            className="border border-ink-accent/40 bg-ink-accent/[0.06] p-3 text-sm text-foreground"
          >
            {addendumStatus}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <Button
            type="button"
            variant="primary"
            onClick={commitAddendum}
            disabled={committing || draftOver}
          >
            {committing ? "Committing…" : "Commit addendum"}
          </Button>
        </div>
      </div>
    </section>
  );
}

function TextTurn({ role, text }: { role: "user" | "assistant" | "system"; text: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <SectionLabel as="div">{ROLE_LABEL[role]}</SectionLabel>
      <p className="whitespace-pre-wrap font-body text-sm leading-relaxed text-foreground">
        {text}
      </p>
    </div>
  );
}

function EmptyState({
  job,
  disabled,
  onPick,
}: {
  job: ChatJob;
  disabled: boolean;
  onPick: (prompt: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3 border border-dashed border-ink-hairline p-4">
      <SectionLabel as="p">Try asking</SectionLabel>
      <div className="flex flex-col gap-2">
        {EXAMPLE_PROMPTS[job].map((prompt) => (
          <Button
            key={prompt}
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => onPick(prompt)}
            className="justify-start text-left font-body"
          >
            {prompt}
          </Button>
        ))}
      </div>
    </div>
  );
}

function ProposedActionCard({
  action,
  status,
  outcome,
  disabled,
  onSkip,
  onConfirm,
}: {
  action: ProposedAction;
  status: EntryStatus;
  outcome: string | null;
  disabled: boolean;
  onSkip: () => void;
  onConfirm: () => void;
}) {
  const { label, intent, destructive } = humaniseAction(action);
  const skipped = status === "skipped";
  const confirmed = status === "confirmed";
  const failed = status === "failed";
  const settled = skipped || confirmed || failed;

  return (
    <div
      className={`flex flex-col gap-2 ${skipped ? "opacity-50" : ""}`}
      aria-label={`Proposed fix: ${label}`}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <SectionLabel as="div">Proposed fix</SectionLabel>
        <span className="text-xs text-foreground/70">· {label}</span>
        {skipped ? (
          <span className="ml-auto font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-foreground/55">
            Skipped
          </span>
        ) : null}
      </div>
      <p className="font-body text-sm leading-relaxed text-foreground">{intent}</p>
      <details className="font-mono text-xs text-foreground/70">
        <summary className="cursor-pointer text-foreground/60 hover:text-foreground">
          Show payload
        </summary>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words border border-ink-hairline bg-ink-mono-fill p-2">
          {JSON.stringify(action, null, 2)}
        </pre>
      </details>
      {confirmed && outcome ? (
        <p
          role="status"
          className="border border-ink-accent/40 bg-ink-accent/[0.06] p-2 text-xs text-foreground"
        >
          {outcome}
        </p>
      ) : null}
      {failed && outcome ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-2 text-xs text-destructive"
        >
          Failed: {outcome}
        </p>
      ) : null}
      {!settled ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onSkip} disabled={disabled}>
            Skip
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "primary"}
            onClick={onConfirm}
            disabled={disabled}
          >
            Confirm & apply
          </Button>
        </div>
      ) : null}
    </div>
  );
}
