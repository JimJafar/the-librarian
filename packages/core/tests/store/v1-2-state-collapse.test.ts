// V1.2 — memory state collapse + conflict cleanup.
//
// Pins the projection's roll-forward behavior for legacy event types
// (`memory.deleted`, `memory.rejected`, `memory.conflict_resolved`) and
// the new archiveMemory verb that replaces deleteMemory.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LibrarianStore, createLibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Scope {
  store: LibrarianStore;
  dataDir: string;
}

function makeScope(): Scope {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-v12-"));
  const store = createLibrarianStore({ dataDir });
  return { store, dataDir };
}

function teardown(scope: Scope | null): void {
  if (!scope) return;
  try {
    scope.store.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(scope.dataDir, { recursive: true, force: true });
}

function writeEvents(dataDir: string, lines: object[]): void {
  fs.writeFileSync(
    path.join(dataDir, "events.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf8",
  );
}

describe("V1.2 — state collapse + tool rename", () => {
  let scope: Scope | null = null;

  beforeEach(() => {
    scope = makeScope();
  });

  afterEach(() => {
    teardown(scope);
    scope = null;
  });

  it("archiveMemory sets status: archived and emits memory.archived", () => {
    const { store } = scope!;
    const created = store.createMemory({
      agent_id: "codex",
      title: "Doomed",
      body: "Going to be archived.",
      category: "tools",
      visibility: "common",
      scope: "project",
      project_key: "demo",
    });
    const archived = store.archiveMemory(created.memory.id, "dashboard")!;
    expect(archived.status).toBe("archived");

    const events = store.readEvents() as { event_type: string; memory_id: string }[];
    expect(
      events.some((e) => e.event_type === "memory.archived" && e.memory_id === created.memory.id),
    ).toBe(true);
  });

  it("createMemory always saves — duplicates surface as informational signal, never refused", () => {
    const { store } = scope!;
    store.createMemory({
      agent_id: "codex",
      title: "A widget preference",
      body: "Prefer the blue widget for inventory listings everywhere.",
      category: "preferences",
      visibility: "common",
      scope: "project",
      project_key: "demo",
      tags: ["widget", "inventory"],
    });

    const second = store.createMemory({
      agent_id: "codex",
      title: "A widget preference",
      body: "Prefer the blue widget for inventory listings — extra phrasing.",
      category: "preferences",
      visibility: "common",
      scope: "project",
      project_key: "demo",
      tags: ["widget", "inventory"],
    });
    expect(second.status).toBe("active");
    expect(second.memory.id).toBeTruthy();
    expect(second.duplicates.length).toBeGreaterThanOrEqual(1);
  });

  it("projection rolls memory.deleted → archived during rebuild", () => {
    const { store, dataDir } = scope!;
    store.close();
    scope = null;
    const ts = "2026-05-19T16:48:42.410Z";
    writeEvents(dataDir, [
      {
        event_id: "evt_seed",
        event_type: "memory.created",
        memory_id: "mem_legacy_d",
        agent_id: "codex",
        created_at: ts,
        payload: {
          memory: {
            id: "mem_legacy_d",
            agent_id: "codex",
            title: "Legacy delete",
            body: "Soft-deleted under the old model.",
            category: "tools",
            visibility: "common",
            scope: "project",
            project_key: "demo",
            applies_to: [],
            priority: "normal",
            confidence: "working",
            tags: [],
            status: "active",
            created_at: ts,
            updated_at: ts,
            last_recalled_at: null,
            recall_count: 0,
            usefulness_score: 0,
            supersedes: [],
            conflicts_with: [],
          },
        },
      },
      {
        event_id: "evt_del",
        event_type: "memory.deleted",
        memory_id: "mem_legacy_d",
        agent_id: "dashboard",
        created_at: ts,
        payload: { memory_id: "mem_legacy_d", agent_id: "dashboard" },
      },
    ]);
    fs.rmSync(path.join(dataDir, "librarian.sqlite"), { force: true });

    const reopened = createLibrarianStore({ dataDir });
    try {
      const row = reopened.getMemory("mem_legacy_d");
      expect(row?.status).toBe("archived");
    } finally {
      reopened.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("projection rolls memory.rejected → archived during rebuild", () => {
    const { store, dataDir } = scope!;
    store.close();
    scope = null;
    const ts = "2026-05-19T16:48:42.410Z";
    writeEvents(dataDir, [
      {
        event_id: "evt_seed",
        event_type: "memory.proposed",
        memory_id: "mem_legacy_r",
        agent_id: "codex",
        created_at: ts,
        payload: {
          memory: {
            id: "mem_legacy_r",
            agent_id: "codex",
            title: "Proposed legacy",
            body: "Goes through the proposal workflow.",
            category: "identity",
            visibility: "common",
            scope: "global",
            applies_to: [],
            priority: "core",
            confidence: "working",
            tags: [],
            status: "proposed",
            created_at: ts,
            updated_at: ts,
            last_recalled_at: null,
            recall_count: 0,
            usefulness_score: 0,
            supersedes: [],
            conflicts_with: [],
          },
        },
      },
      {
        event_id: "evt_rej",
        event_type: "memory.rejected",
        memory_id: "mem_legacy_r",
        agent_id: "dashboard",
        created_at: ts,
        payload: { memory_id: "mem_legacy_r", agent_id: "dashboard" },
      },
    ]);
    fs.rmSync(path.join(dataDir, "librarian.sqlite"), { force: true });

    const reopened = createLibrarianStore({ dataDir });
    try {
      const row = reopened.getMemory("mem_legacy_r");
      expect(row?.status).toBe("archived");
    } finally {
      reopened.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("legacy memory.conflict_resolved rolls forward to the correct three-state status", () => {
    // The pre-V1.2 emitter wrote both `resolution` (the verb chosen) and a
    // pre-computed `status` (the resulting MemoryStatus). We replay all
    // three branches and assert the projection lands them on the new
    // {active | archived} surface.
    const { store, dataDir } = scope!;
    store.close();
    scope = null;
    const ts = "2026-05-19T16:48:42.410Z";

    function seedEvent(id: string, body: string) {
      return {
        event_id: `evt_seed_${id}`,
        event_type: "memory.created",
        memory_id: id,
        agent_id: "codex",
        created_at: ts,
        payload: {
          memory: {
            id,
            agent_id: "codex",
            title: `Pre-resolution ${id}`,
            body,
            category: "tools",
            visibility: "common",
            scope: "project",
            project_key: "demo",
            applies_to: [],
            priority: "normal",
            confidence: "working",
            tags: [],
            status: "active",
            created_at: ts,
            updated_at: ts,
            last_recalled_at: null,
            recall_count: 0,
            usefulness_score: 0,
            supersedes: [],
            conflicts_with: [],
          },
        },
      };
    }

    function resolved(id: string, resolution: string, statusBefore: string) {
      return {
        event_id: `evt_resolved_${id}`,
        event_type: "memory.conflict_resolved",
        memory_id: id,
        agent_id: "dashboard",
        created_at: ts,
        payload: {
          memory_id: id,
          agent_id: "dashboard",
          resolution,
          status: statusBefore,
          patch: {},
        },
      };
    }

    writeEvents(dataDir, [
      seedEvent("mem_archive_c", "Will be archived by the resolution event."),
      // legacy emitter pre-computed status: "archived" for archive/supersede non-canonical
      resolved("mem_archive_c", "archive", "archived"),
      seedEvent("mem_keep_c", "Will stay active under keep_both."),
      resolved("mem_keep_c", "keep_both", "active"),
      seedEvent("mem_supersede_canonical", "Canonical id under supersede stays active."),
      resolved("mem_supersede_canonical", "supersede", "active"),
    ]);
    fs.rmSync(path.join(dataDir, "librarian.sqlite"), { force: true });

    const reopened = createLibrarianStore({ dataDir });
    try {
      expect(reopened.getMemory("mem_archive_c")?.status).toBe("archived");
      expect(reopened.getMemory("mem_keep_c")?.status).toBe("active");
      expect(reopened.getMemory("mem_supersede_canonical")?.status).toBe("active");
    } finally {
      reopened.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("interleaved legacy + V1.1 events project to a coherent final state", () => {
    const { store, dataDir } = scope!;
    store.close();
    scope = null;
    const ts = "2026-05-19T16:48:42.410Z";
    writeEvents(dataDir, [
      {
        event_id: "evt_seed",
        event_type: "memory.created",
        memory_id: "mem_mixed",
        agent_id: "codex",
        created_at: ts,
        payload: {
          memory: {
            id: "mem_mixed",
            agent_id: "codex",
            title: "Mixed history",
            body: "Has every kind of event over its lifetime.",
            category: "tools",
            visibility: "common",
            scope: "project",
            project_key: "demo",
            applies_to: [],
            priority: "normal",
            confidence: "working",
            tags: [],
            status: "active",
            created_at: ts,
            updated_at: ts,
            last_recalled_at: null,
            recall_count: 0,
            usefulness_score: 0,
            supersedes: [],
            conflicts_with: [],
          },
        },
      },
      {
        event_id: "evt_v",
        event_type: "memory.verified",
        memory_id: "mem_mixed",
        agent_id: "codex",
        created_at: ts,
        payload: { memory_id: "mem_mixed", agent_id: "codex", result: "useful" },
      },
      {
        event_id: "evt_cd",
        event_type: "memory.conflict_detected",
        memory_id: "mem_mixed",
        agent_id: "codex",
        created_at: ts,
        payload: { memory_id: "mem_mixed", conflicts_with: ["mem_other"] },
      },
      {
        event_id: "evt_cr",
        event_type: "memory.conflict_resolved",
        memory_id: "mem_mixed",
        agent_id: "dashboard",
        created_at: ts,
        payload: {
          memory_id: "mem_mixed",
          resolution: "keep_both",
          status: "active",
          patch: {},
        },
      },
      {
        event_id: "evt_arc",
        event_type: "memory.archived",
        memory_id: "mem_mixed",
        agent_id: "dashboard",
        created_at: ts,
        payload: { memory_id: "mem_mixed", agent_id: "dashboard" },
      },
    ]);
    fs.rmSync(path.join(dataDir, "librarian.sqlite"), { force: true });

    const reopened = createLibrarianStore({ dataDir });
    try {
      const row = reopened.getMemory("mem_mixed");
      expect(row?.status).toBe("archived");
      expect(row?.usefulness_score).toBe(1);
      expect(row?.conflicts_with).toContain("mem_other");
    } finally {
      reopened.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
