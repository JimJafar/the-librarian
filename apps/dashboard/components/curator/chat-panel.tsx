"use client";

// Curator chat panel (spec 044 D-7 / decisions D-5/6/9/11). Surfaces the whole 2C
// self-improvement loop: discuss a memory (or the corpus) with the curator LLM,
// accept its proposed fixes, and draft an addendum.
//
// SPLIT SCREEN: the conversation lives on the LEFT, an addendum-draft editor on
// the RIGHT. The panel keeps the messages array CLIENT-SIDE — each turn sends the
// whole array and appends the single response (request/response, NO streaming).
//
// THREE response kinds (the `ChatResponse` discriminated union):
//   - message        → prose, rendered inline.
//   - proposed_action → a CONFIRM CARD. The chat NEVER auto-runs an action; the
//     admin clicks Confirm and only THEN does the matching D5 memory mutation run
//     (human-in-the-loop, load-bearing).
//   - addendum_edit  → populates the right-pane addendum draft with the candidate;
//     `over_limit` shows a clear "still over 2 KB" notice (the write backstop
//     rejects >2 KB anyway).

import type { ChatJob, ChatResponse, ProposedAction } from "@librarian/core";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { AddendumStateResult, ChatResult, ConfirmActionResult } from "@/app/curator/actions";

type Role = "system" | "user" | "assistant";
interface ChatMessage {
  role: Role;
  content: string;
}

// A rendered conversation entry: a user/curator message, OR a proposed-action card
// awaiting the admin's confirm. (addendum_edit drives the right pane, not the log.)
type Entry =
  | { kind: "text"; role: "user" | "assistant"; text: string }
  | { kind: "action"; action: ProposedAction };

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
  // The addendum draft can be lifted up (the curator workspace shares it with the
  // lifecycle controls' dry-run). When uncontrolled, the panel owns it internally.
  draft?: string;
  onDraftChange?: (next: string) => void;
}) {
  const router = useRouter();
  // The full conversation sent to the server each turn (request/response, no stream).
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Right pane: the addendum draft + its commit state. Controlled (lifted up) when
  // `draft`/`onDraftChange` are provided, else internal.
  const [internalDraft, setInternalDraft] = useState(initialAddendum);
  const draft = controlledDraft ?? internalDraft;
  const setDraft = (next: string) => {
    if (onDraftChange) onDraftChange(next);
    else setInternalDraft(next);
  };
  const [overLimit, setOverLimit] = useState(false);
  const [addendumStatus, setAddendumStatus] = useState<string | null>(null);
  const [committing, startCommit] = useTransition();

  const send = () => {
    const content = input.trim();
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

  const applyResponse = (response: ChatResponse, sent: ChatMessage[]) => {
    switch (response.kind) {
      case "message":
        setMessages([...sent, { role: "assistant", content: response.text }]);
        setEntries((e) => [...e, { kind: "text", role: "assistant", text: response.text }]);
        break;
      case "proposed_action":
        // The model's turn is the action; keep the assistant aware of it for context.
        setMessages([...sent, { role: "assistant", content: JSON.stringify(response) }]);
        setEntries((e) => [...e, { kind: "action", action: response.action }]);
        break;
      case "addendum_edit":
        setMessages([...sent, { role: "assistant", content: JSON.stringify(response) }]);
        setDraft(response.candidate);
        setOverLimit(response.over_limit === true);
        setAddendumStatus(null);
        setEntries((e) => [
          ...e,
          {
            kind: "text",
            role: "assistant",
            text: "I've drafted addendum guidance — review it in the editor on the right.",
          },
        ]);
        break;
    }
  };

  const confirm = (action: ProposedAction) =>
    startTransition(async () => {
      const res = await onConfirmAction(action);
      setEntries((e) => [
        ...e,
        {
          kind: "text",
          role: "assistant",
          text: res.ok ? `Confirmed — the ${action.type} was applied.` : `Failed: ${res.error}`,
        },
      ]);
      if (res.ok) router.refresh();
    });

  const commitAddendum = () =>
    startCommit(async () => {
      const res = await onSetAddendum({ job, content: draft });
      if (res.ok) {
        setAddendumStatus(
          `Committed — ${job} addendum is now under evaluation (curator will propose, not auto-apply, until you accept).`,
        );
        setOverLimit(false);
        router.refresh();
      } else {
        setAddendumStatus(`Error: ${res.error}`);
      }
    });

  return (
    <section
      className="grid gap-4 rounded-md border bg-card p-4 lg:grid-cols-2"
      aria-label="Curator chat"
    >
      {/* --- Conversation (left) --------------------------------------------- */}
      <div className="flex min-w-0 flex-col gap-3">
        <header>
          <h3 className="font-semibold">Chat with the curator</h3>
          {memoryId ? (
            <p className="text-xs text-muted-foreground">
              Grounded in {memoryTitle ? <strong>{memoryTitle}</strong> : "memory"} (
              <code>{memoryId}</code>)
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              General {job} conversation — no specific memory.
            </p>
          )}
        </header>

        <ol className="flex min-h-[160px] flex-col gap-2" aria-label="Conversation">
          {entries.length === 0 ? (
            <li className="text-sm text-muted-foreground">
              Ask a question or request a fix. The curator proposes; you confirm.
            </li>
          ) : null}
          {entries.map((entry, i) =>
            entry.kind === "text" ? (
              <li
                key={i}
                className={`rounded-md border p-2 text-sm ${
                  entry.role === "user" ? "bg-muted/40" : "bg-background"
                }`}
              >
                <span className="mr-1 text-xs font-medium text-muted-foreground">
                  {entry.role === "user" ? "You" : "Curator"}:
                </span>
                <span className="whitespace-pre-wrap">{entry.text}</span>
              </li>
            ) : (
              <li key={i}>
                <ProposedActionCard
                  action={entry.action}
                  onConfirm={() => confirm(entry.action)}
                  disabled={pending}
                />
              </li>
            ),
          )}
        </ol>

        {chatError ? (
          <p className="text-sm text-destructive" role="alert">
            {chatError}
          </p>
        ) : null}

        <div className="flex items-end gap-2">
          <textarea
            aria-label="Message the curator"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Ask the curator…"
            className="min-h-[60px] flex-1 rounded-md border border-input bg-background p-2 text-sm"
          />
          <button
            type="button"
            onClick={send}
            disabled={pending || input.trim() === ""}
            className="rounded-md border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {pending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>

      {/* --- Addendum draft (right) ------------------------------------------ */}
      <div className="flex min-w-0 flex-col gap-2 border-t pt-4 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
        <header>
          <h3 className="font-semibold">Addendum draft ({job})</h3>
          <p className="text-xs text-muted-foreground">
            Operator guidance for the {job} curator. Committing puts it under evaluation.
          </p>
        </header>
        <textarea
          aria-label="Addendum draft"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setOverLimit(false);
            setAddendumStatus(null);
          }}
          placeholder="The curator's addendum suggestions appear here — or write your own."
          className="min-h-[200px] flex-1 rounded-md border border-input bg-background p-2 font-mono text-sm"
        />
        {overLimit ? (
          <p className="text-sm text-destructive" role="alert">
            That candidate is still over 2 KB — shorten it before committing (the write will reject
            anything over 2 KB).
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={commitAddendum}
            disabled={committing}
            className="rounded-md border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {committing ? "Committing…" : "Commit addendum"}
          </button>
          {addendumStatus ? (
            <span className="text-sm text-muted-foreground">{addendumStatus}</span>
          ) : null}
        </div>
      </div>
    </section>
  );
}

// A proposed fix-now action awaiting the admin's confirm. The chat NEVER runs it;
// the action's `type` + payload IS the matching D5 mutation input.
function ProposedActionCard({
  action,
  onConfirm,
  disabled,
}: {
  action: ProposedAction;
  onConfirm: () => void;
  disabled: boolean;
}) {
  return (
    <div className="rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
      <p className="font-medium">
        Proposed fix: <span className="uppercase">{action.type}</span>
      </p>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-xs">
        {JSON.stringify(action, null, 2)}
      </pre>
      <p className="mt-2 text-xs text-muted-foreground">
        Review the change above. Nothing runs until you confirm.
      </p>
      <button
        type="button"
        onClick={onConfirm}
        disabled={disabled}
        className="mt-2 rounded-md border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        Confirm &amp; apply
      </button>
    </div>
  );
}
