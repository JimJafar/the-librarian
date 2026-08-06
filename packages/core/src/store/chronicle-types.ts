export type ChronicleRunTrigger = "schedule" | "manual";
export type ChronicleNarrativeStatus = "generated" | "skipped" | "failed";

export interface ChronicleRun {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  trigger: ChronicleRunTrigger;
  shelf_id: string;
  shelf_label: string | null;
  period_start: string;
  period_end: string;
  iso_week: string;
  partial: boolean;
  narrative: ChronicleNarrativeStatus;
  path: string | null;
  duration_ms: number;
  model_provider: string | null;
  model_name: string | null;
  usage_input_tokens: number;
  usage_output_tokens: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface CreateChronicleRunInput {
  trigger: ChronicleRunTrigger;
  shelf_id: string;
  shelf_label: string | null;
  period_start: string;
  period_end: string;
  iso_week: string;
  partial: boolean;
  model_provider: string | null;
  model_name: string | null;
}

export interface CompleteChronicleRunInput {
  narrative: ChronicleNarrativeStatus;
  path: string;
  duration_ms: number;
  usage_input_tokens?: number;
  usage_output_tokens?: number;
}

export interface FailChronicleRunInput {
  /** Value-free failure label. */
  error: string;
  duration_ms: number;
  narrative?: ChronicleNarrativeStatus;
  usage_input_tokens?: number;
  usage_output_tokens?: number;
}

export interface ListChronicleRunsInput {
  status?: ChronicleRun["status"];
  trigger?: ChronicleRunTrigger;
  shelfId?: string;
  limit?: number;
}

export interface ChronicleStore {
  createChronicleRun(input: CreateChronicleRunInput): ChronicleRun;
  startChronicleRun(id: string): ChronicleRun;
  completeChronicleRun(id: string, input: CompleteChronicleRunInput): ChronicleRun;
  failChronicleRun(id: string, input: FailChronicleRunInput): ChronicleRun;
  listChronicleRuns(input?: ListChronicleRunsInput): ChronicleRun[];
}
