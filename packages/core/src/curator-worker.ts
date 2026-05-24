// Curator worker (spec §10 pipeline + §12/§14). Composes the curator pieces into
// a single run over ONE slice:
//
//   gather evidence → deterministic pre-pass → build prompt → LLM → parse output
//   → validate → apply → record run summary.
//
// It owns the run lifecycle (create → start → complete/fail) and records token
// usage. The LLM client is injected (built from the admin config by the caller),
// so this is fully testable without network. The server-side scheduler that
// selects due slices, skips by input hash, and locks slices is separate (§12/§14).

import { createHash } from "node:crypto";
import type { ApplyPolicy } from "./curator-apply-policy.js";
import { applyOperations } from "./curator-apply.js";
import type { EvidenceSlice } from "./curator-evidence.js";
import { gatherMemoryEvidence, gatherSessionEvidence } from "./curator-evidence.js";
import { LlmClientError, type LlmClient } from "./curator-llm-client.js";
import { parseCuratorOutput } from "./curator-output.js";
import { deterministicPrepass } from "./curator-prepass.js";
import { CURATOR_PROMPT_VERSION, buildCuratorPrompt } from "./curator-prompt.js";
import { redactSecrets } from "./curator-redaction.js";
import { validateOperations } from "./curator-validate.js";
import type { CurationRun } from "./store/curation-store.js";
import type { LibrarianStore } from "./store/librarian-store.js";

export interface RunCurationCaps {
  maxMemories?: number;
  maxSessions?: number;
  maxBodyChars?: number;
  maxEventsPerSession?: number;
}

export interface RunCurationOptions {
  store: LibrarianStore;
  llmClient: LlmClient;
  /** "schedule" | "manual" | "maintenance" (recorded on the run). */
  trigger: string;
  /** Curator actor for common-slice writes (e.g. "system-memory-curator"). */
  actorId: string;
  policy: ApplyPolicy;
  promptAddendum?: string;
  /** Recorded on the run for observability. */
  model: { provider: string; name: string };
  caps?: RunCurationCaps;
}

const DEFAULT_MAX_MEMORIES = 200;
const DEFAULT_MAX_SESSIONS = 50;

export async function runCuration(
  slice: EvidenceSlice,
  options: RunCurationOptions,
): Promise<CurationRun> {
  const { store, caps = {} } = options;

  const memory = gatherMemoryEvidence(store.db, slice, {
    maxMemories: caps.maxMemories ?? DEFAULT_MAX_MEMORIES,
    ...(caps.maxBodyChars !== undefined ? { maxBodyChars: caps.maxBodyChars } : {}),
  });
  const sessions = gatherSessionEvidence(store.db, slice, {
    maxSessions: caps.maxSessions ?? DEFAULT_MAX_SESSIONS,
    ...(caps.maxEventsPerSession !== undefined
      ? { maxEventsPerSession: caps.maxEventsPerSession }
      : {}),
    ...(caps.maxBodyChars !== undefined ? { maxSummaryChars: caps.maxBodyChars } : {}),
  });
  const prepass = deterministicPrepass(memory);

  const run = store.createCurationRun({
    trigger: options.trigger,
    visibility: slice.kind === "agent_private" ? "agent_private" : "common",
    project_key: slice.kind === "common_project" ? (slice.projectKey ?? null) : null,
    agent_id: slice.kind === "agent_private" ? (slice.agentId ?? null) : null,
    input_hash: computeInputHash(slice, memory, sessions, options.promptAddendum ?? ""),
    input_memory_ids: [
      ...memory.activeMemories,
      ...memory.proposedMemories,
      ...memory.tombstones,
    ].map((m) => m.id),
    input_session_ids: sessions.sessions.map((s) => s.id),
    model_provider: options.model.provider,
    model_name: options.model.name,
  });

  // startCurationRun onward is inside the try so any throw terminalizes the run
  // (fail) rather than leaving it dangling. createCurationRun is outside: if it
  // throws there is no run row to fail.
  try {
    store.startCurationRun(run.id);
    const messages = buildCuratorPrompt({
      memory,
      sessions,
      prepass,
      ...(options.promptAddendum !== undefined ? { promptAddendum: options.promptAddendum } : {}),
    });
    const completion = await options.llmClient.complete({ messages });

    const parsed = parseCuratorOutput(completion.content);
    if (parsed.parseError) {
      // Whole-output failure (bad JSON / no operations array) — no usable ops.
      // Per-operation schema rejects are handled below.
      return store.failCurationRun(run.id, { error: "parse_error" });
    }
    // Schema-rejected operations are recorded as skipped (the reason is value-free).
    for (const rejected of parsed.rejected) {
      store.recordCurationOperation({
        run_id: run.id,
        operation_type: "unknown",
        status: "skipped",
        confidence: 0,
        risk_level: "normal",
        rationale: `schema: ${rejected.reason}`,
        proposed_payload: {},
      });
    }

    const context = { slice, memory, sessions, prepass };
    const validated = validateOperations(parsed.operations, context);
    const summary = applyOperations(validated, context, {
      store,
      runId: run.id,
      actorId: options.actorId,
      policy: options.policy,
    });

    return store.completeCurationRun(run.id, {
      summary: `applied ${summary.applied}, proposed ${summary.proposed}, skipped ${summary.skipped + parsed.rejected.length}, failed ${summary.failed}`,
      usage_input_tokens: completion.usage?.promptTokens ?? 0,
      usage_output_tokens: completion.usage?.completionTokens ?? 0,
    });
  } catch (error) {
    return store.failCurationRun(run.id, { error: errorLabel(error) });
  }
}

// Value-free error label for the run record — never the error message (which
// could carry store/content detail).
function errorLabel(error: unknown): string {
  return error instanceof LlmClientError ? `llm_${error.kind}` : "error";
}

// Input hash (§10.2): slice + memory ids/updated/status + tombstone fingerprints
// + session ids/last-activity + a prompt version + the (redacted) admin addendum,
// so editing the addendum or any evidence permits a fresh run. Order-independent.
function computeInputHash(
  slice: EvidenceSlice,
  memory: ReturnType<typeof gatherMemoryEvidence>,
  sessions: ReturnType<typeof gatherSessionEvidence>,
  addendum: string,
): string {
  const parts: string[] = [
    `slice:${slice.kind}:${slice.projectKey ?? ""}:${slice.agentId ?? ""}`,
    `prompt:${CURATOR_PROMPT_VERSION}`,
    `addendum:${redactSecrets(addendum).redacted}`,
  ];
  for (const m of [...memory.activeMemories, ...memory.proposedMemories]) {
    parts.push(`m:${m.id}:${m.updatedAt}:${m.status}`);
  }
  for (const t of memory.tombstones) {
    parts.push(`t:${t.id}:${t.contentFingerprint}`);
  }
  for (const s of sessions.sessions) {
    parts.push(`s:${s.id}:${s.lastActivityAt}`);
  }
  return createHash("sha256").update(parts.sort().join("\n"), "utf8").digest("hex");
}
