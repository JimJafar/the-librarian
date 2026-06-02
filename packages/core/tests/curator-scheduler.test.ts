// Curator due-slice selection (sessions-rethink §12.4) over a real store: which
// slices the scheduler would run now, given last-completed runs and the
// configured interval.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type ScheduleConfig,
  createLibrarianStore,
  createSqliteCuratorMemorySource,
  createSqliteCurationRunReader,
  selectDueSlices,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let store: LibrarianStore | null = null;
let dataDir = "";
const NOW = new Date();
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-sched-"));
  store = createLibrarianStore({ dataDir });
});
afterEach(() => {
  try {
    store?.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  store = null;
});

const config = (over: Partial<ScheduleConfig> = {}): ScheduleConfig => ({
  intervalMinutes: 60,
  ...over,
});

function seedCommonMemory(projectKey: string) {
  store!.createMemory({
    agent_id: "agent-a",
    title: "t",
    body: "b",
    category: "lessons",
    visibility: "common",
    scope: "project",
    project_key: projectKey,
    priority: "normal",
    confidence: "working",
  });
}

/** A completed apply run for a common project, with completed_at set in the past. */
function completedRun(projectKey: string, completedAt: Date) {
  const run = store!.createCurationRun({
    trigger: "schedule",
    visibility: "common",
    input_hash: `h-${projectKey}-${completedAt.toISOString()}`,
    project_key: projectKey,
  });
  store!.completeCurationRun(run.id);
  store!.db
    .prepare("UPDATE memory_curation_runs SET completed_at = ? WHERE id = ?")
    .run(completedAt.toISOString(), run.id);
}

function dueProjectKeys() {
  return selectDueSlices(
    createSqliteCuratorMemorySource(store!.db),
    createSqliteCurationRunReader(store!.db),
    config(),
    NOW,
  )
    .filter((d) => d.slice.kind === "common_project")
    .map((d) => (d.slice.kind === "common_project" ? d.slice.projectKey : ""));
}

describe("selectDueSlices", () => {
  it("returns nothing for an empty store", () => {
    expect(
      selectDueSlices(
        createSqliteCuratorMemorySource(store!.db),
        createSqliteCurationRunReader(store!.db),
        config(),
        NOW,
      ),
    ).toEqual([]);
  });

  it("a never-run slice with content is due (never_run)", () => {
    seedCommonMemory("proj-new");
    const due = selectDueSlices(
      createSqliteCuratorMemorySource(store!.db),
      createSqliteCurationRunReader(store!.db),
      config(),
      NOW,
    );
    const hit = due.find((d) => d.slice.kind === "common_project");
    expect(hit?.reason).toBe("never_run");
  });

  it("not due before the interval elapses", () => {
    seedCommonMemory("proj-recent");
    completedRun("proj-recent", minutesAgo(30));
    expect(dueProjectKeys()).not.toContain("proj-recent");
  });

  it("is due once the interval has elapsed", () => {
    seedCommonMemory("proj-stale");
    completedRun("proj-stale", minutesAgo(120));
    const hit = selectDueSlices(
      createSqliteCuratorMemorySource(store!.db),
      createSqliteCurationRunReader(store!.db),
      config(),
      NOW,
    ).find((d) => d.slice.kind === "common_project" && d.slice.projectKey === "proj-stale");
    expect(hit?.reason).toBe("interval_reached");
  });
});
