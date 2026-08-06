import type {
  ChronicleEntryWriter,
  ChronicleFacts,
  ChronicleHandoffFact,
  ChronicleMemoryFact,
  ChronicleNarrative,
  ChronicleRenderedEntry,
} from "./types.js";

export interface RenderChronicleOptions {
  generatedAt?: string;
}

export interface ChronicleWriteResult extends ChronicleRenderedEntry {
  hash?: string;
}

export function renderChronicle(
  facts: ChronicleFacts,
  narrative?: ChronicleNarrative,
  options: RenderChronicleOptions = {},
): ChronicleRenderedEntry {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const periodDate = facts.period.end.slice(0, 10);
  const partialSuffix = facts.period.partial ? ` (partial — through ${periodDate})` : "";
  const title = `Chronicle: ${facts.period.isoWeek}${partialSuffix}`;
  const lines: string[] = [
    "---",
    `period_start: ${facts.period.start}`,
    `period_end: ${facts.period.end}`,
    `generated_at: ${generatedAt}`,
    `partial: ${facts.period.partial}`,
    "---",
    "",
    `# ${title}`,
    "",
    narrative?.headline.trim() || digestHeadline(facts),
    "",
  ];

  if (narrative?.narrativeMd.trim()) {
    lines.push("## The week's story", "", narrative.narrativeMd.trim(), "");
  }

  lines.push(
    "## Decisions & lessons filed",
    "",
    "### Created",
    "",
    ...memoryLines(facts.memories.created),
    "",
    "### Updated",
    "",
    ...memoryLines(facts.memories.updated),
    "",
    "### Archived",
    "",
    ...memoryLines(facts.memories.archived),
    "",
    "## Handoffs",
    "",
    "### Created",
    "",
    ...handoffLines(facts.handoffs.created),
    "",
    "### Claimed",
    "",
    ...claimedHandoffLines(facts),
    "",
    "## Loose ends",
    "",
    `- Pending memory proposals: ${facts.memories.pendingProposals}`,
    ...facts.handoffs.stillOpenOlder.map(
      (row) => `- Unclaimed handoff: ${inline(row.title)} (\`${code(row.id)}\`)`,
    ),
    "",
    ...openQuestionLines(facts),
  );

  if (narrative && narrative.blogSeeds.length > 0) {
    lines.push("", "## Blog seeds", "");
    for (const seed of narrative.blogSeeds.slice(0, 3)) {
      lines.push(
        `### ${inline(seed.title)}`,
        "",
        seed.angle.trim(),
        "",
        `Sources: ${seed.sources.map((source) => `\`${code(source)}\``).join(", ") || "None"}`,
        "",
      );
    }
  }

  lines.push(
    "## Appendix",
    "",
    "### Vault commits",
    "",
    "| Source | Commits |",
    "| --- | ---: |",
    ...recordRows(facts.commits.bySource),
    "",
    "### Curator runs",
    "",
    "| Pipeline / result | Count |",
    "| --- | ---: |",
    ...prefixedRecordRows("Grooming status", facts.runs.curation.statuses),
    ...prefixedRecordRows("Grooming operation", facts.runs.curation.operations),
    ...prefixedRecordRows("Intake status", facts.runs.intake.statuses),
    ...prefixedRecordRows("Intake operation", facts.runs.intake.operations),
    "",
    "### Token usage",
    "",
    "| Provider / model | Input | Output | Total |",
    "| --- | ---: | ---: | ---: |",
    ...(facts.runs.tokenUsage.length > 0
      ? facts.runs.tokenUsage.map(
          (row) =>
            `| ${table(row.provider)} / ${table(row.model)} | ${row.inputTokens} | ${row.outputTokens} | ${row.inputTokens + row.outputTokens} |`,
        )
      : ["| None recorded | 0 | 0 | 0 |"]),
    "",
    "Intake token usage is unavailable in the current run-log schema.",
  );

  if (facts.warnings.length > 0) {
    lines.push("", "### Collection notes", "", ...facts.warnings.map((row) => `- ${inline(row)}`));
  }

  return {
    path: `references/chronicle/${facts.period.isoWeek}.md`,
    content: `${lines.join("\n").trimEnd()}\n`,
  };
}

export function writeChronicle(
  facts: ChronicleFacts,
  narrative: ChronicleNarrative | undefined,
  writer: ChronicleEntryWriter,
  options: RenderChronicleOptions = {},
): ChronicleWriteResult {
  const entry = renderChronicle(facts, narrative, options);
  const written = writer.upsert({ isoWeek: facts.period.isoWeek, content: entry.content });
  return { ...entry, ...written };
}

function digestHeadline(facts: ChronicleFacts): string {
  const commits = sum(Object.values(facts.commits.bySource));
  return `${count(commits, "vault commit")}, ${count(facts.memories.created.length, "memory")} filed, and ${count(facts.handoffs.created.length, "handoff")} created.`;
}

function memoryLines(rows: ChronicleMemoryFact[]): string[] {
  if (rows.length === 0) return ["- None."];
  return rows.map((row) => {
    const tags = row.tags.length > 0 ? `; tags: ${row.tags.map(inline).join(", ")}` : "";
    return `- ${inline(row.title)} (\`${code(row.id)}\`) — ${inline(row.status)}; agent: ${inline(row.agentId)}${tags}`;
  });
}

function handoffLines(rows: ChronicleHandoffFact[]): string[] {
  if (rows.length === 0) return ["- None."];
  return rows.map(
    (row) =>
      `- ${inline(row.title)} (\`${code(row.id)}\`)${row.projectKey ? ` — ${inline(row.projectKey)}` : ""}`,
  );
}

function claimedHandoffLines(facts: ChronicleFacts): string[] {
  if (facts.handoffs.claimed.length === 0) return ["- None."];
  return facts.handoffs.claimed.map((row) => {
    const latency = row.latencySeconds === null ? "unknown latency" : duration(row.latencySeconds);
    return `- ${inline(row.title)} (\`${code(row.id)}\`) — claimed after ${latency}`;
  });
}

function openQuestionLines(facts: ChronicleFacts): string[] {
  if (facts.handoffs.openQuestions.length === 0) return ["### Open questions", "", "- None."];
  const out = ["### Open questions", ""];
  for (const row of facts.handoffs.openQuestions) {
    out.push(
      `#### ${inline(row.handoffId)}`,
      "",
      `Source: \`${code(row.path)}\``,
      "",
      row.markdown.trim(),
      "",
    );
  }
  return out;
}

function recordRows(values: Record<string, number>): string[] {
  const entries = Object.entries(values);
  if (entries.length === 0) return ["| None | 0 |"];
  return entries.map(([label, value]) => `| ${table(label)} | ${value} |`);
}

function prefixedRecordRows(prefix: string, values: Record<string, number>): string[] {
  return Object.entries(values).map(
    ([label, value]) => `| ${table(prefix)}: ${table(label)} | ${value} |`,
  );
}

function inline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function table(value: string): string {
  return inline(value).replaceAll("|", "\\|");
}

function code(value: string): string {
  return inline(value).replaceAll("`", "′");
}

function count(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? "" : "s"}`;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}
