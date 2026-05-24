// Session lifecycle orchestration (spec §4.3, §5, §9).
//
// This is the layer every harness adapter calls. It composes the pure
// privacy detector, the local-state store, and the CLI wrapper into the
// four decisions a hook actually makes:
//
//   handlePrompt    — privacy gate + idempotent start/resume (§3.3, §5.2)
//   handleCheckpoint— gated, rate-limited checkpoint (§5.3)
//   handlePause     — pause on exit/idle, never end (§5.4)
//   handleToggle    — flip privacy mode, ending an attached session on
//                     the public→private transition (§3.1, §4.3)
//
// Two invariants dominate the design:
//   - FAIL CLOSED on privacy: if local state can't be read/written we make
//     no automatic Librarian call (§9). Privacy enforcement failing is the
//     only thing that suppresses; an ordinary CLI failure is logged and
//     swallowed so it never blocks the user.
//   - NEVER auto-end on a guess (§5.4). The only automatic end is the
//     user-initiated public→private transition.

import {
  type CliSession,
  type LibrarianCli,
  type SessionStatus,
  LibrarianCliError,
} from "./cli.js";
import { type PrivacyMarkers, detectPrivacySignal } from "./privacy.js";
import {
  type HarnessLibrarianState,
  type StateLocation,
  type StateOptions,
  StateIoError,
  StateLockError,
  STATE_VERSION,
  loadState,
  updateState,
} from "./state.js";

const PRIVATE_END_REASON = "switching to private mode";
const DEFAULT_PAUSE_SUMMARY = "Session paused (harness exit or idle).";
const DEFAULT_START_SUMMARY = "Session started by the harness lifecycle helper.";

export interface CheckpointThresholds {
  minIntervalMinutes: number;
  minFilesTouched: number;
  minToolCalls: number;
  onCompaction: boolean;
  onTaskCompleted: boolean;
}

export interface LifecycleConfig {
  enabled: boolean;
  privacyDetection: boolean;
  autoStart: boolean;
  autoResume: boolean;
  autoPause: boolean;
  checkpoint: CheckpointThresholds;
  idlePauseAfterHours: number;
  privateMarkers?: string[];
  publicMarkers?: string[];
}

// Defaults from §5.3 / §10.
export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
  enabled: true,
  privacyDetection: true,
  autoStart: true,
  autoResume: true,
  autoPause: true,
  checkpoint: {
    minIntervalMinutes: 30,
    minFilesTouched: 2,
    minToolCalls: 5,
    onCompaction: true,
    onTaskCompleted: true,
  },
  idlePauseAfterHours: 6,
};

export interface LifecycleLogEntry {
  level: "info" | "warn" | "error";
  message: string;
  error?: unknown;
}

export interface LifecycleDeps {
  cli: LibrarianCli;
  location: StateLocation;
  config?: Partial<LifecycleConfig>;
  stateOptions?: StateOptions;
  now?: () => number;
  logger?: (entry: LifecycleLogEntry) => void;
}

export type PromptAction =
  | "disabled"
  | "suppressed-error"
  | "suppressed-private"
  | "entered-private"
  | "exited-private"
  | "toggled-public"
  | "started"
  | "resumed"
  | "active"
  | "error";

export interface PromptOutcome {
  action: PromptAction;
  privacy: "public" | "private";
  sessionId?: string;
}

export interface CheckpointInput {
  trigger?: "compaction" | "task-completed" | "activity";
  /** Files touched since the last checkpoint. */
  filesTouched?: number;
  /** Tool/command calls since the last checkpoint. */
  toolCalls?: number;
  summary?: string;
}

export type CheckpointAction =
  | "disabled"
  | "suppressed-private"
  | "suppressed-error"
  | "no-session"
  | "skipped-gate"
  | "checkpointed"
  | "error";

export interface CheckpointOutcome {
  action: CheckpointAction;
  sessionId?: string;
}

export type PauseAction =
  | "disabled"
  | "suppressed-private"
  | "suppressed-error"
  | "no-session"
  | "paused"
  | "error";

export interface PauseOutcome {
  action: PauseAction;
}

export interface LibrarianLifecycle {
  handlePrompt(prompt: string): PromptOutcome;
  handleCheckpoint(input?: CheckpointInput): CheckpointOutcome;
  handlePause(input?: PauseInput): PauseOutcome;
  handleToggle(): PromptOutcome;
}

export interface PauseInput {
  summary?: string;
}

export function createLibrarianLifecycle(deps: LifecycleDeps): LibrarianLifecycle {
  const { cli, location } = deps;
  const config: LifecycleConfig = {
    ...DEFAULT_LIFECYCLE_CONFIG,
    ...deps.config,
    checkpoint: { ...DEFAULT_LIFECYCLE_CONFIG.checkpoint, ...deps.config?.checkpoint },
  };
  const stateOptions = deps.stateOptions ?? {};
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? (() => {});

  const markers: PrivacyMarkers = {};
  if (config.privateMarkers) markers.privateMarkers = config.privateMarkers;
  if (config.publicMarkers) markers.publicMarkers = config.publicMarkers;

  function nowIso(): string {
    return new Date(now()).toISOString();
  }

  // Rebuild state from the authoritative location each time, carrying the
  // few fields the location does not own.
  function composeState(
    privacy: "public" | "private",
    fields: {
      librarianSessionId?: string | undefined;
      enteredPrivateAt?: string | undefined;
      lastActivityAt?: string | undefined;
      lastCheckpointAt?: string | undefined;
    },
  ): HarnessLibrarianState {
    const state: HarnessLibrarianState = {
      version: STATE_VERSION,
      harness: location.harness,
      harness_session_key: location.harnessSessionKey,
      privacy,
    };
    if (location.sourceRef !== undefined) state.source_ref = location.sourceRef;
    if (location.cwd !== undefined) state.cwd = location.cwd;
    if (location.projectKey !== undefined) state.project_key = location.projectKey;
    if (fields.librarianSessionId !== undefined)
      state.librarian_session_id = fields.librarianSessionId;
    if (fields.enteredPrivateAt !== undefined) state.entered_private_at = fields.enteredPrivateAt;
    if (fields.lastActivityAt !== undefined) state.last_activity_at = fields.lastActivityAt;
    if (fields.lastCheckpointAt !== undefined) state.last_checkpoint_at = fields.lastCheckpointAt;
    return state;
  }

  // A handler body wrapped so privacy-state I/O failures fail closed and
  // CLI failures are logged but never thrown to the harness (§9).
  function guard<T>(failClosed: T, cliFallback: T, body: () => T): T {
    try {
      return body();
    } catch (err) {
      if (err instanceof StateIoError || err instanceof StateLockError) {
        log({
          level: "error",
          message: "librarian lifecycle: state unavailable, failing closed",
          error: err,
        });
        return failClosed;
      }
      if (err instanceof LibrarianCliError) {
        log({ level: "warn", message: `librarian lifecycle: CLI ${err.kind} error`, error: err });
        return cliFallback;
      }
      throw err;
    }
  }

  function resolveSession(): { session: CliSession; action: "started" | "resumed" } | null {
    if (config.autoResume) {
      const statuses: SessionStatus[] = ["active", "paused"];
      const listArgs: Parameters<LibrarianCli["listSessions"]>[0] = {
        harness: location.harness,
        statuses,
      };
      if (location.sourceRef !== undefined) listArgs.sourceRef = location.sourceRef;
      if (location.cwd !== undefined) listArgs.cwd = location.cwd;
      if (location.projectKey !== undefined) listArgs.projectKey = location.projectKey;
      const matches = cli.listSessions(listArgs);
      // Exactly one good match → resume it. Zero or many (we are unattended
      // in a hook) → start fresh rather than guess (§5.2).
      if (matches.length === 1) {
        return { session: cli.continueSession(matches[0]!.id), action: "resumed" };
      }
    }
    if (!config.autoStart) return null;
    const startArgs: Parameters<LibrarianCli["startSession"]>[0] = {
      harness: location.harness,
      summary: DEFAULT_START_SUMMARY,
    };
    if (location.sourceRef !== undefined) startArgs.sourceRef = location.sourceRef;
    if (location.cwd !== undefined) startArgs.cwd = location.cwd;
    if (location.projectKey !== undefined) startArgs.projectKey = location.projectKey;
    return { session: cli.startSession(startArgs), action: "started" };
  }

  // Find-or-create the public session under the state lock so concurrent
  // hooks converge on ONE attached session (§9): the second caller, once it
  // holds the lock, sees the id the first wrote and does not start again.
  function ensureSession(): PromptOutcome {
    let action: PromptAction = "active";
    const next = updateState(
      location,
      (current) => {
        if (current?.librarian_session_id) {
          action = "active";
          return composeState("public", {
            librarianSessionId: current.librarian_session_id,
            lastActivityAt: nowIso(),
            lastCheckpointAt: current.last_checkpoint_at,
          });
        }
        const resolved = resolveSession();
        if (!resolved) {
          action = "active";
          return composeState("public", { lastActivityAt: nowIso() });
        }
        action = resolved.action;
        return composeState("public", {
          librarianSessionId: resolved.session.id,
          lastActivityAt: nowIso(),
        });
      },
      stateOptions,
    );
    const outcome: PromptOutcome = { action, privacy: "public" };
    if (next.librarian_session_id !== undefined) outcome.sessionId = next.librarian_session_id;
    return outcome;
  }

  // Enter private mode (§4.3). We write the private local state FIRST so that
  // even if the end call fails, no future automatic call is made; then we end
  // the previously-attached public session with a neutral reason. This is a
  // deliberate reordering of §4.3's steps in service of its own fail-closed
  // intent — the end state is identical, but a partial failure still suppresses.
  function enterPrivate(attachedId: string | undefined): PromptOutcome {
    updateState(
      location,
      () => composeState("private", { enteredPrivateAt: nowIso() }),
      stateOptions,
    );
    if (attachedId) {
      try {
        cli.endSession(attachedId, PRIVATE_END_REASON);
      } catch (err) {
        log({
          level: "error",
          message: `librarian lifecycle: failed to end session ${attachedId} on private transition`,
          error: err,
        });
      }
    }
    return { action: "entered-private", privacy: "private" };
  }

  function handleToggle(): PromptOutcome {
    return guard<PromptOutcome>(
      { action: "suppressed-error", privacy: "private" },
      { action: "error", privacy: "private" },
      () => {
        const state = loadState(location, stateOptions);
        if (state?.privacy === "private") {
          updateState(location, () => composeState("public", {}), stateOptions);
          return { action: "toggled-public", privacy: "public" };
        }
        return enterPrivate(state?.librarian_session_id);
      },
    );
  }

  return {
    handlePrompt(prompt) {
      if (!config.enabled) return { action: "disabled", privacy: "public" };
      return guard<PromptOutcome>(
        { action: "suppressed-error", privacy: "private" },
        { action: "error", privacy: "public" },
        () => {
          const state = loadState(location, stateOptions);
          const isPrivate = state?.privacy === "private";

          if (config.privacyDetection) {
            const { signal } = detectPrivacySignal(prompt, markers);
            if (signal === "toggle") return handleToggle();
            if (signal === "enter-private") return enterPrivate(state?.librarian_session_id);
            if (signal === "exit-private") {
              // Flip to public locally, but DO NOT record this prompt — public
              // Librarian behaviour resumes from the next prompt (§3.3).
              updateState(location, () => composeState("public", {}), stateOptions);
              return { action: "exited-private", privacy: "public" };
            }
          }

          // No marker. While private, make no call at all (§9).
          if (isPrivate) return { action: "suppressed-private", privacy: "private" };
          return ensureSession();
        },
      );
    },

    handleCheckpoint(input = {}) {
      if (!config.enabled) return { action: "disabled" };
      return guard<CheckpointOutcome>({ action: "suppressed-error" }, { action: "error" }, () => {
        const state = loadState(location, stateOptions);
        if (state?.privacy === "private") return { action: "suppressed-private" };
        const sessionId = state?.librarian_session_id;
        if (!sessionId) return { action: "no-session" };
        if (!shouldCheckpoint(input, state, now(), config.checkpoint)) {
          return { action: "skipped-gate", sessionId };
        }
        cli.checkpointSession(sessionId, input.summary ?? DEFAULT_START_SUMMARY);
        updateState(
          location,
          (current) =>
            composeState("public", {
              librarianSessionId: sessionId,
              lastActivityAt: nowIso(),
              lastCheckpointAt: nowIso(),
              enteredPrivateAt: current?.entered_private_at,
            }),
          stateOptions,
        );
        return { action: "checkpointed", sessionId };
      });
    },

    handlePause(input = {}) {
      if (!config.enabled || !config.autoPause) return { action: "disabled" };
      return guard<PauseOutcome>({ action: "suppressed-error" }, { action: "error" }, () => {
        const state = loadState(location, stateOptions);
        if (state?.privacy === "private") return { action: "suppressed-private" };
        const sessionId = state?.librarian_session_id;
        if (!sessionId) return { action: "no-session" };
        cli.pauseSession(sessionId, input.summary ?? DEFAULT_PAUSE_SUMMARY);
        // Detach locally: the paused session is resumed via the list match
        // on the next public prompt (§5.2), not by a lingering local id.
        updateState(
          location,
          (current) =>
            composeState("public", {
              lastActivityAt: nowIso(),
              lastCheckpointAt: current?.last_checkpoint_at,
            }),
          stateOptions,
        );
        return { action: "paused" };
      });
    },

    handleToggle,
  };
}

// Decide whether to checkpoint (§5.3). High-value boundaries (compaction,
// task-completed) always pass; activity-driven checkpoints require new work
// since the last checkpoint AND either an accumulated-work gate or the time
// gate — which together both express "at least one gate" and dedupe (§9).
function shouldCheckpoint(
  input: CheckpointInput,
  state: HarnessLibrarianState | null,
  nowMs: number,
  cfg: CheckpointThresholds,
): boolean {
  if (input.trigger === "compaction" && cfg.onCompaction) return true;
  if (input.trigger === "task-completed" && cfg.onTaskCompleted) return true;

  const files = input.filesTouched ?? 0;
  const tools = input.toolCalls ?? 0;
  const hasSummary = typeof input.summary === "string" && input.summary.trim().length > 0;
  const newWork = files > 0 || tools > 0 || hasSummary;
  if (!newWork) return false; // nothing new since last checkpoint → duplicate

  // The count gate fires on accumulated work — callers pass deltas *since the
  // last checkpoint*, so it is self-rate-limiting (work must re-accumulate).
  const countGate = files >= cfg.minFilesTouched || tools >= cfg.minToolCalls;

  const lastMs = state?.last_checkpoint_at ? Date.parse(state.last_checkpoint_at) : NaN;
  const hasPriorCheckpoint = !Number.isNaN(lastMs);
  // Before the first checkpoint there is no "elapsed since last checkpoint",
  // so the time gate does not apply — a young session must accumulate real
  // work (count gate) or supply an explicit summary, not checkpoint a trivial
  // change just because no prior checkpoint exists.
  if (!hasPriorCheckpoint) return countGate || hasSummary;

  const elapsedMin = (nowMs - lastMs) / 60_000;
  const timeGate = elapsedMin >= cfg.minIntervalMinutes;
  // After the first checkpoint: substantial work checkpoints immediately;
  // otherwise wait out the interval (which also rate-limits summaries).
  return countGate || timeGate || (hasSummary && timeGate);
}
