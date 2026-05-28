// Candidate-slice enumeration for the curator scheduler (spec §9 + §14): which
// slices have curatable content, drawn from memories (active/proposed) and
// sessions, before due-gating is applied.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LibrarianStore, createLibrarianStore, listCuratorSlices } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let store: LibrarianStore | null = null;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-slices-"));
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

function mem(over: Record<string, unknown>, options: Record<string, unknown> = {}) {
  return store!.createMemory(
    {
      agent_id: "agent-a",
      title: "t",
      body: "b",
      category: "lessons",
      visibility: "common",
      scope: "project",
      priority: "normal",
      confidence: "working",
      ...over,
    },
    options,
  ).memory;
}

describe("listCuratorSlices", () => {
  it("returns nothing for an empty store", () => {
    expect(listCuratorSlices(store!.db)).toEqual([]);
  });

  it("enumerates the global slice and common projects (Section 4d.3 — memory visibility retired; agent_private slices now sourced from sessions only)", () => {
    mem({ scope: "global", project_key: undefined });
    mem({ project_key: "proj-x" });
    mem({ project_key: "proj-y" });

    const slices = listCuratorSlices(store!.db);
    expect(slices).toContainEqual({ kind: "common_global" });
    expect(slices).toContainEqual({ kind: "common_project", projectKey: "proj-x" });
    expect(slices).toContainEqual({ kind: "common_project", projectKey: "proj-y" });
    // The agent_private slice is no longer populated by memories alone
    // (the `visibility=agent_private` column is gone). Sessions still
    // drive that slice via their own visibility column.
    const agentPrivateSlices = slices.filter((s) => s.kind === "agent_private");
    expect(agentPrivateSlices).toHaveLength(0);
  });

  it("excludes a project whose only memory is archived", () => {
    const m = mem({ project_key: "proj-dead" });
    store!.archiveMemory(m.id);
    const projects = listCuratorSlices(store!.db).filter((s) => s.kind === "common_project");
    expect(projects).not.toContainEqual({ kind: "common_project", projectKey: "proj-dead" });
  });

  it("enumerates a project that has only a session (no memories yet)", () => {
    store!.startSession({ title: "s", project_key: "proj-sessiononly", visibility: "common" });
    expect(listCuratorSlices(store!.db)).toContainEqual({
      kind: "common_project",
      projectKey: "proj-sessiononly",
    });
  });

  it("enumerates an agent_private slice from a private session owner", () => {
    store!.startSession({ title: "s", visibility: "agent_private", agent_id: "agent-priv" });
    expect(listCuratorSlices(store!.db)).toContainEqual({
      kind: "agent_private",
      agentId: "agent-priv",
    });
  });

  it("is deterministically ordered", () => {
    mem({ project_key: "proj-b" });
    mem({ project_key: "proj-a" });
    const projectKeys = listCuratorSlices(store!.db)
      .filter((s) => s.kind === "common_project")
      .map((s) => (s.kind === "common_project" ? s.projectKey : ""));
    expect(projectKeys).toEqual(["proj-a", "proj-b"]);
  });
});
