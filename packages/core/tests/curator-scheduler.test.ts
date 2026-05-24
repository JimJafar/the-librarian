// Curator due-slice selection (spec §14 + §7.2) over a real store: which slices
// the scheduler would run now, given last-completed runs + new-session counts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ScheduleConfig,
  createLibrarianStore,
  selectDueSlices,
  type LibrarianStore,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let store: LibrarianStore | null = null;
let dataDir = "";
const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

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
  intervalDays: 1,
  time: "03:00",
  minSessions: 10,
  maxDays: 7,
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
  return selectDueSlices(store!.db, config(), NOW)
    .filter((d) => d.slice.kind === "common_project")
    .map((d) => (d.slice.kind === "common_project" ? d.slice.projectKey : ""));
}

describe("selectDueSlices", () => {
  it("returns nothing for an empty store", () => {
    expect(selectDueSlices(store!.db, config(), NOW)).toEqual([]);
  });

  it("a never-run slice with content is due (never_run)", () => {
    seedCommonMemory("proj-new");
    const due = selectDueSlices(store!.db, config(), NOW);
    const hit = due.find((d) => d.slice.kind === "common_project");
    expect(hit?.reason).toBe("never_run");
  });

  it("not due before the interval elapses", () => {
    seedCommonMemory("proj-recent");
    completedRun("proj-recent", new Date(NOW.getTime() - 3_600_000)); // 1h ago
    expect(dueProjectKeys()).not.toContain("proj-recent");
  });

  it("self-gates when the interval is due but too few new sessions", () => {
    seedCommonMemory("proj-idle");
    completedRun("proj-idle", daysAgo(2)); // interval elapsed, no new sessions
    expect(dueProjectKeys()).not.toContain("proj-idle");
  });

  it("is due once enough new sessions accumulate", () => {
    seedCommonMemory("proj-busy");
    completedRun("proj-busy", daysAgo(2));
    for (let i = 0; i < 12; i++) {
      store!.startSession({ title: `s${i}`, project_key: "proj-busy", visibility: "common" });
    }
    const hit = selectDueSlices(store!.db, config(), NOW).find(
      (d) => d.slice.kind === "common_project" && d.slice.projectKey === "proj-busy",
    );
    expect(hit?.reason).toBe("min_sessions");
    expect(hit?.newSessionCount).toBe(12);
  });

  it("forces a run past max_days even with no new sessions", () => {
    seedCommonMemory("proj-stale");
    completedRun("proj-stale", daysAgo(8));
    const hit = selectDueSlices(store!.db, config(), NOW).find(
      (d) => d.slice.kind === "common_project" && d.slice.projectKey === "proj-stale",
    );
    expect(hit?.reason).toBe("max_days");
  });
});
