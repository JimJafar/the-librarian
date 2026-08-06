import type { CurationOperation, CurationRun } from "../store/curation-types.js";
import type { VaultCommit } from "../store/git/git-history.js";
import type { HandoffDetail } from "../store/handoff-types.js";
import type { IntakeOperation, IntakeRun } from "../store/intake-types.js";
import type { Memory } from "../store/memory-types.js";
import type { VaultCommitSource } from "../store/vault-restore.js";

export interface ChroniclePeriod {
  /** Inclusive ISO instant. */
  start: string;
  /** Exclusive ISO instant. */
  end: string;
  /** ISO week label, e.g. `2026-W31`. */
  isoWeek: string;
  partial: boolean;
}

export interface ChronicleCollectorDeps {
  recentCommits(input: { limit?: number; before?: string }): VaultCommit[];
  listMemories(): Memory[];
  readHandoffs(): ChronicleHandoffRead[];
  listCurationRuns(): CurationRun[];
  listCurationOperations(runId: string): CurationOperation[];
  listIntakeRuns(): IntakeRun[];
  listIntakeOperations(runId: string): IntakeOperation[];
}

export interface ChronicleHandoffRead {
  path: string;
  handoff?: HandoffDetail;
  /** Value-free failure label. */
  error?: string;
}

export interface ChronicleCommitFact extends VaultCommit {
  source: VaultCommitSource;
}

export interface ChronicleMemoryFact {
  id: string;
  title: string;
  body: string;
  status: string;
  tags: string[];
  agentId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChronicleHandoffFact {
  id: string;
  path: string;
  title: string;
  projectKey: string | null;
  createdAt: string;
  claimedAt: string | null;
  createdByAgentId: string | null;
  createdInHarness: string | null;
}

export interface ChronicleClaimedHandoffFact extends ChronicleHandoffFact {
  claimedAt: string;
  latencySeconds: number | null;
}

export interface ChronicleTokenUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ChronicleBlogSeed {
  title: string;
  angle: string;
  sources: string[];
}

export interface ChronicleNarrative {
  headline: string;
  narrativeMd: string;
  blogSeeds: ChronicleBlogSeed[];
}

export interface ChronicleRenderedEntry {
  path: string;
  content: string;
}

export interface ChronicleEntryWriter {
  upsert(input: { isoWeek: string; content: string }): { path: string; hash?: string };
}

export interface ChronicleFacts {
  period: ChroniclePeriod;
  commits: {
    entries: ChronicleCommitFact[];
    bySource: Record<string, number>;
  };
  memories: {
    created: ChronicleMemoryFact[];
    updated: ChronicleMemoryFact[];
    archived: ChronicleMemoryFact[];
    pendingProposals: number;
  };
  handoffs: {
    created: ChronicleHandoffFact[];
    claimed: ChronicleClaimedHandoffFact[];
    stillOpenOlder: ChronicleHandoffFact[];
    openQuestions: Array<{ handoffId: string; path: string; markdown: string }>;
  };
  runs: {
    curation: { statuses: Record<string, number>; operations: Record<string, number> };
    intake: { statuses: Record<string, number>; operations: Record<string, number> };
    tokenUsage: ChronicleTokenUsage[];
    /** Intake's current decision-log schema does not retain provider usage. */
    intakeTokenUsageAvailable: false;
  };
  warnings: string[];
}
