// Transcript-intake: the harness-agnostic capture door (spec
// 2026-06-16-harness-auto-capture, T1; SC5, SC6, SC11).
//
// This is the server-side half of automatic capture's *ingestion* clock
// (spec §4.2/§4.3): a per-turn delta from any harness adapter lands here,
// is redacted, and is appended forward-only to a per-conversation sidecar
// buffer. The *extraction* clock (settle-sweep → curator) is T2 and reads
// the buffer this writes — it is deliberately NOT here.
//
// Contract design (spec SC11 "uniform contract"): the payload is
// harness-agnostic — the Claude adapter is the first consumer, but a Pi /
// Hermes / mock adapter validates against this same shape. Validation is
// strict + teaching (AGENTS.md "errors teach"); a malformed body is a 400,
// never a thrown 500.
//
// Privacy invariants (AGENTS.md "privacy is the product", spec §4.5):
//   - REDACT ON INTAKE, BEFORE the disk write. redactSecrets runs over each
//     turn's text and the REDACTED text is what's appended — no raw secret
//     ever reaches the sidecar (SC5).
//   - The buffer lives OUTSIDE the git vault, at `<data-dir>/transcripts/`,
//     sibling to `vault/` and to the other sidecars (`intake-runs.json`) —
//     never committed (SC6). `data/` is gitignored.
//   - `conv_id` is sanitized to a single safe path segment so a hostile
//     adapter can't path-traverse out of `transcripts/` (SC6).
//   - GATE COHERENCE (spec §5 Q-gate, resolved): if the intake gate that
//     would drain the buffer is OFF (`curator.intake.enabled` via
//     isIntakeEnabled), this REFUSES and buffers NOTHING — no raw text at
//     rest for a dead pipeline. The caller/hook is told capture is disabled
//     so it can log it; full sweep-side coherence is T2.
//
// Fail-soft (AGENTS.md): an internal error here returns a clean JSON result,
// never a 500 stack trace that could break an agent's turn.

import fs from "node:fs";
import path from "node:path";
import {
  TRANSCRIPTS_DIR,
  type LibrarianStore,
  endedMarkerPath,
  isIntakeEnabled,
  redactSecrets,
  sanitizeConvId,
  transcriptBufferPath,
} from "@librarian/core";
import { z } from "zod";
import { logger } from "../logging.js";

// The sidecar buffer path contract (dir, sanitisation, buffer + marker paths)
// lives in @librarian/core so the T1 ingestion half and the T2 settle-sweep can
// never drift on it. Re-exported here so existing T1 consumers/tests keep their
// import surface.
export { TRANSCRIPTS_DIR, endedMarkerPath, sanitizeConvId, transcriptBufferPath };

// Strict runtime validation (the repo validates rich inputs with zod inside the
// handler; see schemas.ts note). strictObject so an unknown key is a 400 rather
// than silently ignored — a malformed adapter should hear about it. The TS
// payload types are inferred FROM these schemas so the contract has a single
// source of truth (and lines up with exactOptionalPropertyTypes).
const turnSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  ts: z.string().optional(),
});

const payloadSchema = z.strictObject({
  conv_id: z.string().min(1),
  harness: z.string().min(1),
  seq: z.number().int().nonnegative(),
  turns: z.array(turnSchema),
  ended: z.boolean().optional(),
});

/** A single already-non-private turn (the adapter filtered private turns upstream). */
export type TranscriptTurn = z.infer<typeof turnSchema>;

/**
 * The uniform, harness-agnostic delta payload (spec SC11). `conv_id` keys the
 * per-conversation buffer (= the harness's conversation/session id — never
 * `$USER` or `cwd`, spec §4.11); `harness` names the adapter; `seq` is the
 * adapter's monotonic delta counter; `turns` are already-non-private; `ended`
 * is the explicit-end accelerator hint (consumed by the T2 settle-sweep).
 */
export type TranscriptIntakePayload = z.infer<typeof payloadSchema>;

/** A validated-and-handled intake outcome, folded into an HTTP response by the route. */
export interface TranscriptIntakeResult {
  /** HTTP status the route should send. */
  status: number;
  /** JSON body the route should send. */
  body: Record<string, unknown>;
}

/**
 * Render redacted turns as a forward-only markdown append. Each turn is a small
 * block carrying its role, optional timestamp, and the REDACTED text. The format
 * is deliberately simple + greppable; the T2 extractor reads it back whole.
 */
function renderTurns(turns: TranscriptTurn[], seq: number): string {
  return turns
    .map((turn) => {
      const stamp = turn.ts ? ` ts=${turn.ts}` : "";
      const { redacted } = redactSecrets(turn.text);
      return `### ${turn.role} (seq=${seq}${stamp})\n\n${redacted}\n`;
    })
    .join("\n");
}

/**
 * Validate, gate-check, redact, and append a transcript delta to its sidecar
 * buffer. Pure over the store + raw body; returns the outcome the route folds
 * into a response. Never throws — every failure path returns a clean result and
 * logs a warning (fail-soft, AGENTS.md).
 *
 * Outcomes:
 *   - malformed body → 400 with a teaching `error` (SC11).
 *   - intake gate off → 200 `{ accepted: false, disabled: true }`, NOTHING
 *     written (spec Q-gate / gate-refuse).
 *   - well-formed + gate on → 200 `{ accepted: true, buffered: <n> }`, redacted
 *     turns appended (SC5, SC6, SC11).
 *   - unexpected internal error → 200 `{ accepted: false }` + a logged warning
 *     (fail-soft; never a 500 into the agent's turn).
 */
export function handleTranscriptIntake(
  store: LibrarianStore,
  raw: unknown,
): TranscriptIntakeResult {
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) {
    // Teaching error: name the first offending field + reason (AGENTS.md).
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "(root)";
    return {
      status: 400,
      body: {
        accepted: false,
        error: `Malformed transcript payload at "${where}": ${issue?.message ?? "invalid"}`,
      },
    };
  }
  const payload = parsed.data;

  try {
    // GATE COHERENCE (spec Q-gate): refuse + buffer nothing when the intake gate
    // that drains the buffer is off — no raw text at rest for a dead pipeline.
    if (!isIntakeEnabled(store)) {
      return {
        status: 200,
        body: {
          accepted: false,
          disabled: true,
          reason:
            "Capture is disabled: the curator intake gate (curator.intake.enabled) is off. " +
            "Enable intake in the dashboard to turn automatic capture on. Nothing was buffered.",
        },
      };
    }

    // REDACT ON INTAKE, then append forward-only. The dir is created lazily and
    // lives OUTSIDE the git vault (sibling to vault/, like intake-runs.json).
    const bufferPath = transcriptBufferPath(store.dataDir, payload.conv_id);
    fs.mkdirSync(path.dirname(bufferPath), { recursive: true });
    const block = renderTurns(payload.turns, payload.seq);
    // Always end the append with a trailing newline so successive deltas don't
    // run together; an empty `turns[]` is a valid (no-op) heartbeat.
    fs.appendFileSync(bufferPath, payload.turns.length ? `${block}\n` : "", "utf8");

    // EXPLICIT-END ACCELERATOR (spec §4.4): when the adapter signals the
    // conversation ended (`ended:true`), drop a sibling `<conv_id>.ended` marker so
    // the T2 settle-sweep extracts this buffer on its NEXT tick without waiting for
    // the idle window. The marker is a minimal sidecar (its mere presence is the
    // signal) and is deleted with the buffer after extraction. Touch is fail-soft:
    // a marker-write failure only loses the accelerator (idle still settles the
    // buffer), so it must not fail the delta that was already buffered.
    if (payload.ended) {
      try {
        fs.writeFileSync(endedMarkerPath(store.dataDir, payload.conv_id), "", "utf8");
      } catch (markerError) {
        logger.warn(
          { harness: payload.harness, err: (markerError as Error).message },
          "transcript end-marker write failed; falling back to idle settle (fail-soft)",
        );
      }
    }

    return {
      status: 200,
      body: {
        accepted: true,
        buffered: payload.turns.length,
        conv_id: payload.conv_id,
        ...(payload.ended ? { ended: true } : {}),
      },
    };
  } catch (error) {
    // Fail-soft: never throw out of the request handler. Log + return a clean,
    // non-accepting result so the caller knows the delta did NOT land (and can
    // re-ship next turn) — without a stack trace reaching the agent.
    logger.warn(
      { harness: payload.harness, seq: payload.seq, err: (error as Error).message },
      "transcript intake failed; delta not buffered (fail-soft)",
    );
    return { status: 200, body: { accepted: false } };
  }
}
