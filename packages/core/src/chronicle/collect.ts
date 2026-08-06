import { classifyVaultCommit } from "../store/vault-restore.js";
import type {
  ChronicleClaimedHandoffFact,
  ChronicleCollectorDeps,
  ChronicleFacts,
  ChronicleHandoffFact,
  ChronicleMemoryFact,
  ChroniclePeriod,
  ChronicleTokenUsage,
} from "./types.js";

const COMMIT_PAGE_SIZE = 200;

export function collectChronicleFacts(
  period: ChroniclePeriod,
  deps: ChronicleCollectorDeps,
): ChronicleFacts {
  const start = Date.parse(period.start);
  const end = Date.parse(period.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error("Chronicle period must be a valid non-empty [start, end) range");
  }

  const warnings: string[] = [];
  const commits = collectCommits(deps, start, end, warnings);
  const memories = collectMemories(deps, start, end);
  const handoffs = collectHandoffs(deps, start, end, warnings);
  const runs = collectRuns(deps, start, end);

  return {
    period: { ...period },
    commits: {
      entries: commits,
      bySource: countBy(commits.map((row) => row.source)),
    },
    memories,
    handoffs,
    runs,
    warnings,
  };
}

function collectCommits(
  deps: ChronicleCollectorDeps,
  start: number,
  end: number,
  warnings: string[],
) {
  const entries: ChronicleFacts["commits"]["entries"] = [];
  const seen = new Set<string>();
  let before: string | undefined;

  for (;;) {
    const page = deps.recentCommits({ limit: COMMIT_PAGE_SIZE, ...(before ? { before } : {}) });
    if (page.length === 0) break;

    let reachedStart = false;
    for (const row of page) {
      if (seen.has(row.hash)) continue;
      seen.add(row.hash);
      const at = Date.parse(row.date);
      if (Number.isFinite(at) && at < start) reachedStart = true;
      if (deps.includeCommit && !deps.includeCommit(row)) continue;
      if (!Number.isFinite(at)) {
        warnings.push(`Skipped commit with invalid date: ${row.hash}`);
        continue;
      }
      if (at >= start && at < end) {
        entries.push({ ...row, source: classifyVaultCommit(row.subject) });
      }
    }

    const oldest = page.at(-1);
    if (!oldest || reachedStart || page.length < COMMIT_PAGE_SIZE || oldest.hash === before) break;
    before = oldest.hash;
  }

  return entries;
}

function collectMemories(deps: ChronicleCollectorDeps, start: number, end: number) {
  const all = deps.listMemories();
  const created = all.filter((row) => inPeriod(row.created_at, start, end)).map(memoryFact);
  const archived = all
    .filter((row) => row.status === "archived" && inPeriod(row.updated_at, start, end))
    .map(memoryFact);
  const updated = all
    .filter(
      (row) =>
        row.status !== "archived" &&
        !inPeriod(row.created_at, start, end) &&
        inPeriod(row.updated_at, start, end),
    )
    .map(memoryFact);
  return {
    created,
    updated,
    archived,
    pendingProposals: all.filter((row) => row.status === "proposed").length,
  };
}

function memoryFact(
  row: ReturnType<ChronicleCollectorDeps["listMemories"]>[number],
): ChronicleMemoryFact {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    tags: [...row.tags],
    agentId: row.agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function collectHandoffs(
  deps: ChronicleCollectorDeps,
  start: number,
  end: number,
  warnings: string[],
) {
  const created: ChronicleHandoffFact[] = [];
  const claimed: ChronicleClaimedHandoffFact[] = [];
  const stillOpenOlder: ChronicleHandoffFact[] = [];
  const openQuestions: ChronicleFacts["handoffs"]["openQuestions"] = [];

  for (const read of deps.readHandoffs()) {
    if (!read.handoff) {
      warnings.push(`Skipped malformed handoff: ${read.path}`);
      continue;
    }
    const row = read.handoff;
    const fact = handoffFact(read.path, row);
    const createdInPeriod = inPeriod(row.created_at, start, end);
    if (createdInPeriod) {
      created.push(fact);
      const markdown = extractOpenQuestions(row.document_md);
      if (markdown) openQuestions.push({ handoffId: row.handoff_id, path: read.path, markdown });
    }
    if (row.claimed_at && inPeriod(row.claimed_at, start, end)) {
      claimed.push({
        ...fact,
        claimedAt: row.claimed_at,
        latencySeconds: latencySeconds(row.created_at, row.claimed_at),
      });
    }
    if (!row.claimed_at && Date.parse(row.created_at) < start) stillOpenOlder.push(fact);
  }

  return { created, claimed, stillOpenOlder, openQuestions };
}

function handoffFact(
  path: string,
  row: NonNullable<ReturnType<ChronicleCollectorDeps["readHandoffs"]>[number]["handoff"]>,
): ChronicleHandoffFact {
  return {
    id: row.handoff_id,
    path,
    title: row.title,
    projectKey: row.project_key,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    createdByAgentId: row.created_by_agent_id,
    createdInHarness: row.created_in_harness,
  };
}

function extractOpenQuestions(document: string): string {
  const heading = /^## Open questions[^\S\r\n]*$/im.exec(document);
  if (!heading) return "";

  const rest = document.slice(heading.index + heading[0].length).replace(/^\r?\n/, "");
  const nextHeading = /^##\s.*$/m.exec(rest);
  return (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim();
}

function latencySeconds(createdAt: string, claimedAt: string): number | null {
  const created = Date.parse(createdAt);
  const claimed = Date.parse(claimedAt);
  if (!Number.isFinite(created) || !Number.isFinite(claimed) || claimed < created) return null;
  return Math.round((claimed - created) / 1000);
}

function collectRuns(deps: ChronicleCollectorDeps, start: number, end: number) {
  const curationRuns = deps
    .listCurationRuns()
    .filter((run) => inPeriod(run.created_at, start, end));
  const intakeRuns = deps.listIntakeRuns().filter((run) => inPeriod(run.created_at, start, end));
  const curationOps = curationRuns.flatMap((run) => deps.listCurationOperations(run.id));
  const intakeOps = intakeRuns.flatMap((run) => deps.listIntakeOperations(run.id));

  return {
    curation: {
      statuses: countBy(curationRuns.map((run) => run.status)),
      operations: countBy(curationOps.map((op) => `${op.operation_type}:${op.status}`)),
    },
    intake: {
      statuses: countBy(intakeRuns.map((run) => run.status)),
      operations: countBy(intakeOps.map((op) => `${op.action}:${op.outcome}`)),
    },
    tokenUsage: aggregateTokenUsage(curationRuns),
    intakeTokenUsageAvailable: false as const,
  };
}

function aggregateTokenUsage(
  runs: ReturnType<ChronicleCollectorDeps["listCurationRuns"]>,
): ChronicleTokenUsage[] {
  const totals = new Map<string, ChronicleTokenUsage>();
  for (const run of runs) {
    if (run.usage_input_tokens === 0 && run.usage_output_tokens === 0) continue;
    const provider = run.model_provider ?? "unknown";
    const model = run.model_name ?? "unknown";
    const key = `${provider}\0${model}`;
    const current = totals.get(key) ?? { provider, model, inputTokens: 0, outputTokens: 0 };
    current.inputTokens += run.usage_input_tokens;
    current.outputTokens += run.usage_output_tokens;
    totals.set(key, current);
  }
  return [...totals.values()].sort((a, b) =>
    `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`),
  );
}

function countBy(values: string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function inPeriod(value: string, start: number, end: number): boolean {
  const at = Date.parse(value);
  return Number.isFinite(at) && at >= start && at < end;
}
