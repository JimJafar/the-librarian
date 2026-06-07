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
import type { ApplyPolicy } from "./grooming-apply-policy.js";
import { applyOperations } from "./grooming-apply.js";
import type { EvidenceSlice } from "./grooming-evidence.js";
import { gatherMemoryEvidence } from "./grooming-evidence.js";
import { LlmClientError, type LlmClient } from "./grooming-llm-client.js";
import { parseGroomingOutput } from "./grooming-output.js";
import { deterministicPrepass } from "./grooming-prepass.js";
import { GROOMING_PROMPT_VERSION, buildGroomingPrompt } from "./grooming-prompt.js";
import { redactSecrets } from "./grooming-redaction.js";
import { validateOperations } from "./grooming-validate.js";
import type { CurationRun } from "./store/curation-store.js";
import type { LibrarianStore } from "./store/librarian-store.js";

export interface RunCurationCaps {
  maxMemories?: number;
  maxBodyChars?: number;
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
  /**
   * Under-evaluation force-propose (spec 044 D-3): when true, the grooming addendum
   * is being evaluated, so no op auto-applies (would-be applies → proposals,
   * would-be archives → skipped) and proposals are tagged with `addendumVersion`.
   * Default false → byte-identical to before D3a.
   */
  underEvaluation?: boolean;
  /** The addendum version (git hash) under evaluation; tags produced proposals. */
  addendumVersion?: string | null;
  /**
   * Grooming dry-run (spec 044 D-4): when true this run uses a CANDIDATE addendum
   * (passed via `promptAddendum`, never written to the vault) and force-proposes
   * every op (nothing auto-applies), tagging proposals `dry_run` (+ `dryRunCandidate`)
   * instead of an addendum version. Independent of `underEvaluation`.
   */
  dryRun?: boolean;
  /** The dry-run candidate label (e.g. "candidate v2"); tags produced proposals. */
  dryRunCandidate?: string | null;
  /** Recorded on the run for observability. */
  model: { provider: string; name: string };
  caps?: RunCurationCaps;
  /** manual/maintenance runs may bypass the input-hash idempotency skip (§10.2). */
  bypassSkip?: boolean;
}

const DEFAULT_MAX_MEMORIES = 200;

/**
 * Run one curation pass over a slice. Returns the run record, or null when the
 * run was skipped by input-hash idempotency (an identical completed apply-run
 * already exists and the trigger didn't bypass it, §10.2) — no run is created
 * and no LLM call is made.
 */
export async function runCuration(
  slice: EvidenceSlice,
  options: RunCurationOptions,
): Promise<CurationRun | null> {
  const { store, caps = {} } = options;

  const memory = store.gatherMemoryEvidence(slice, {
    maxMemories: caps.maxMemories ?? DEFAULT_MAX_MEMORIES,
    ...(caps.maxBodyChars !== undefined ? { maxBodyChars: caps.maxBodyChars } : {}),
  });
  const prepass = deterministicPrepass(memory);

  // §10.2 idempotency: skip if an identical completed apply-run exists, unless a
  // manual/maintenance trigger explicitly bypasses. Checked BEFORE creating a run
  // or calling the LLM, so a no-op tick costs nothing.
  const inputHash = computeInputHash(slice, memory, options.promptAddendum ?? "");
  if (!options.bypassSkip && store.findCompletedApplyRun(inputHash)) {
    return null;
  }

  const run = store.createCurationRun({
    trigger: options.trigger,
    visibility: slice.kind === "agent_private" ? "agent_private" : "common",
    project_key: slice.kind === "common_project" ? (slice.projectKey ?? null) : null,
    agent_id: slice.kind === "agent_private" ? (slice.agentId ?? null) : null,
    input_hash: inputHash,
    input_memory_ids: [
      ...memory.activeMemories,
      ...memory.proposedMemories,
      ...memory.tombstones,
    ].map((m) => m.id),
    model_provider: options.model.provider,
    model_name: options.model.name,
  });

  // startCurationRun onward is inside the try so any throw terminalizes the run
  // (fail) rather than leaving it dangling. createCurationRun is outside: if it
  // throws there is no run row to fail.
  try {
    store.startCurationRun(run.id);
    const messages = buildGroomingPrompt({
      memory,
      prepass,
      ...(options.promptAddendum !== undefined ? { promptAddendum: options.promptAddendum } : {}),
    });
    const completion = await options.llmClient.complete({ messages });

    const parsed = parseGroomingOutput(completion.content);
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

    const context = { slice, memory, prepass };
    const validated = validateOperations(parsed.operations, context);
    const summary = applyOperations(validated, context, {
      store,
      runId: run.id,
      actorId: options.actorId,
      policy: options.policy,
      ...(options.underEvaluation
        ? { underEvaluation: true, addendumVersion: options.addendumVersion }
        : {}),
      ...(options.dryRun ? { dryRun: true, dryRunCandidate: options.dryRunCandidate } : {}),
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
// + a prompt version + the (redacted) admin addendum, so editing the addendum or
// any evidence permits a fresh run. Order-independent.
function computeInputHash(
  slice: EvidenceSlice,
  memory: ReturnType<typeof gatherMemoryEvidence>,
  addendum: string,
): string {
  const parts: string[] = [
    `slice:${slice.kind}:${slice.projectKey ?? ""}:${slice.agentId ?? ""}`,
    `prompt:${GROOMING_PROMPT_VERSION}`,
    `addendum:${redactSecrets(addendum).redacted}`,
  ];
  for (const m of [...memory.activeMemories, ...memory.proposedMemories]) {
    parts.push(`m:${m.id}:${m.updatedAt}:${m.status}`);
  }
  for (const t of memory.tombstones) {
    parts.push(`t:${t.id}:${t.contentFingerprint}`);
  }
  return createHash("sha256").update(parts.sort().join("\n"), "utf8").digest("hex");
}
