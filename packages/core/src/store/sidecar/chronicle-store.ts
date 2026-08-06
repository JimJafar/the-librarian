import fs from "node:fs";
import path from "node:path";
import { makeId, nowIso } from "../../constants.js";
import type {
  ChronicleRun,
  ChronicleStore,
  CompleteChronicleRunInput,
  CreateChronicleRunInput,
  FailChronicleRunInput,
  ListChronicleRunsInput,
} from "../chronicle-types.js";

export const CHRONICLE_RUNS_FILE = "chronicle-runs.json";

export interface JsonChronicleStoreDeps {
  filePath: string;
  now?: () => string;
  generateId?: () => string;
}

interface ChronicleData {
  runs: Record<string, ChronicleRun>;
}

const TERMINAL = new Set<ChronicleRun["status"]>(["completed", "failed"]);

export function createJsonChronicleStore(deps: JsonChronicleStoreDeps): ChronicleStore {
  const now = deps.now ?? nowIso;
  const generateId = deps.generateId ?? (() => makeId("chr"));

  function readAll(): ChronicleData {
    if (!fs.existsSync(deps.filePath)) return { runs: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(deps.filePath, "utf8")) as Partial<ChronicleData>;
      return { runs: parsed.runs && typeof parsed.runs === "object" ? parsed.runs : {} };
    } catch {
      return { runs: {} };
    }
  }

  function writeAll(data: ChronicleData): void {
    fs.mkdirSync(path.dirname(deps.filePath), { recursive: true });
    fs.writeFileSync(deps.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  function requireRun(data: ChronicleData, id: string): ChronicleRun {
    const run = data.runs[id];
    if (!run) throw new Error(`No Chronicle run found for id ${id}`);
    return run;
  }

  function createChronicleRun(input: CreateChronicleRunInput): ChronicleRun {
    const run: ChronicleRun = {
      id: generateId(),
      status: "pending",
      trigger: input.trigger,
      shelf_id: input.shelf_id,
      shelf_label: input.shelf_label,
      period_start: input.period_start,
      period_end: input.period_end,
      iso_week: input.iso_week,
      partial: input.partial,
      narrative: "skipped",
      path: null,
      duration_ms: 0,
      model_provider: input.model_provider,
      model_name: input.model_name,
      usage_input_tokens: 0,
      usage_output_tokens: 0,
      error: null,
      created_at: now(),
      started_at: null,
      completed_at: null,
    };
    const data = readAll();
    data.runs[run.id] = run;
    writeAll(data);
    return run;
  }

  function startChronicleRun(id: string): ChronicleRun {
    const data = readAll();
    const run = requireRun(data, id);
    if (!TERMINAL.has(run.status)) {
      run.status = "running";
      run.started_at ??= now();
      writeAll(data);
    }
    return run;
  }

  function completeChronicleRun(id: string, input: CompleteChronicleRunInput): ChronicleRun {
    const data = readAll();
    const run = requireRun(data, id);
    if (!TERMINAL.has(run.status)) {
      run.status = "completed";
      run.narrative = input.narrative;
      run.path = input.path;
      run.duration_ms = input.duration_ms;
      run.usage_input_tokens = input.usage_input_tokens ?? 0;
      run.usage_output_tokens = input.usage_output_tokens ?? 0;
      run.completed_at = now();
      writeAll(data);
    }
    return run;
  }

  function failChronicleRun(id: string, input: FailChronicleRunInput): ChronicleRun {
    const data = readAll();
    const run = requireRun(data, id);
    if (!TERMINAL.has(run.status)) {
      run.status = "failed";
      run.error = input.error;
      run.duration_ms = input.duration_ms;
      run.narrative = input.narrative ?? run.narrative;
      run.usage_input_tokens = input.usage_input_tokens ?? run.usage_input_tokens;
      run.usage_output_tokens = input.usage_output_tokens ?? run.usage_output_tokens;
      run.completed_at = now();
      writeAll(data);
    }
    return run;
  }

  function listChronicleRuns(input: ListChronicleRunsInput = {}): ChronicleRun[] {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    return Object.values(readAll().runs)
      .filter((run) => (input.status ? run.status === input.status : true))
      .filter((run) => (input.trigger ? run.trigger === input.trigger : true))
      .filter((run) => (input.shelfId ? run.shelf_id === input.shelfId : true))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
      .slice(0, limit);
  }

  return {
    createChronicleRun,
    startChronicleRun,
    completeChronicleRun,
    failChronicleRun,
    listChronicleRuns,
  };
}
