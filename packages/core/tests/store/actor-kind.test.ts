// actor_kind projection column (naming contract §6 / §14 open-question #3).
//
// The store persists an explicit `actor_kind` (agent/admin/system/cli) derived
// from each row's `agent_id` via the resolver's `actorKind`, so the dashboard
// can group/filter by actor kind in SQL and the audit ledger carries the kind
// as metadata. This pins that the column is populated on both the `memories`
// projection and the `events` audit table.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LibrarianStore, createLibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Scope {
  store: LibrarianStore;
  dataDir: string;
}

function scope(): Scope {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-actor-kind-"));
  const store = createLibrarianStore({ dataDir });
  return { store, dataDir };
}

function teardown(s: Scope | null): void {
  if (!s) return;
  try {
    s.store.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(s.dataDir, { recursive: true, force: true });
}

function seedMemory(store: LibrarianStore, agent_id: string, title: string): void {
  store.createMemory({
    agent_id,
    title,
    body: "body text",
    category: "projects",
    visibility: "common",
    scope: "project",
    project_key: "the-librarian",
    priority: "normal",
    confidence: "working",
  });
}

function memoryKindByAgent(store: LibrarianStore): Map<string, string | null> {
  const rows = store.db.prepare("SELECT agent_id, actor_kind FROM memories").all() as Array<{
    agent_id: string | null;
    actor_kind: string | null;
  }>;
  return new Map(rows.map((r) => [String(r.agent_id), r.actor_kind]));
}

describe("actor_kind projection column", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  it("derives actor_kind on memories from each row's agent_id", () => {
    const { store } = s!;
    seedMemory(store, "guybrush", "an agent");
    seedMemory(store, "system-memory-curator", "a system actor");
    seedMemory(store, "dashboard-admin", "an admin actor");
    seedMemory(store, "cli", "the cli operator");
    seedMemory(store, "unknown-agent", "the legacy sentinel");

    const kinds = memoryKindByAgent(store);
    expect(kinds.get("guybrush")).toBe("agent");
    expect(kinds.get("system-memory-curator")).toBe("system");
    expect(kinds.get("dashboard-admin")).toBe("admin");
    expect(kinds.get("cli")).toBe("cli");
    expect(kinds.get("unknown-agent")).toBe("agent");
  });

  it("records actor_kind on the events audit table", () => {
    const { store } = s!;
    seedMemory(store, "system-memory-curator", "system write");
    const rows = store.db
      .prepare("SELECT agent_id, actor_kind FROM events WHERE agent_id = ?")
      .all("system-memory-curator") as Array<{ agent_id: string; actor_kind: string | null }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.actor_kind).toBe("system");
  });

  it("survives a projection rebuild", () => {
    const { store } = s!;
    seedMemory(store, "dashboard-admin", "persisted");
    store.rebuildIndex();
    expect(memoryKindByAgent(store).get("dashboard-admin")).toBe("admin");
  });
});
