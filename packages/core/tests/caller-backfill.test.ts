// Phase-3 backfill (naming contract §9 Phase 3) coverage.
//
// `backfillCallerIds` reattributes stored caller ids to their canonical form
// across both storage subsystems, each via its own durable path:
//   - memories are JSONL-canonical, so reattribution goes through the
//     append-event `bulkUpdateMemory` path (survives a projection rebuild);
//   - sessions are SQLite-authoritative (R3), so reattribution is a direct,
//     durable UPDATE on the `sessions` table.
//
// It applies a one-time backfill alias map (claude → claude-code,
// system → system-migration) AFTER normalisation. Per §9 it must never guess
// `unknown-agent`, must be a no-op in dry-run, and must be idempotent.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LibrarianStore, backfillCallerIds, createLibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Scope {
  store: LibrarianStore;
  dataDir: string;
}

const BACKFILL_ALIASES = {
  claude: "claude-code",
  system: "system-migration",
} as const;

function scope(): Scope {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-backfill-"));
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

function seedMemory(store: LibrarianStore, agent_id: string, title: string): string {
  const result = store.createMemory({
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
  return result.memory.id;
}

function memoryAgentIds(store: LibrarianStore): string[] {
  return [...store.distinctValues({ field: "agent_id", include_archived: true })].sort();
}

function sessionAgentIds(store: LibrarianStore): { createdBy: string[]; current: string[] } {
  return {
    createdBy: [
      ...store.distinctSessionValues({ field: "created_by_agent_id", include_ended: true }),
    ].sort(),
    current: [
      ...store.distinctSessionValues({ field: "current_agent_id", include_ended: true }),
    ].sort(),
  };
}

describe("backfillCallerIds (Phase-3 backfill)", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
    const { store } = s;
    // Memories: a legacy `system` actor (the seed), a non-canonical raw that
    // collapses by pure normalisation, an already-canonical id, and the
    // legacy sentinel which must be left alone.
    seedMemory(store, "system", "seed policy");
    seedMemory(store, "system", "seed identity");
    seedMemory(store, "Claude Code", "raw harness name");
    seedMemory(store, "codex", "already canonical");
    seedMemory(store, "unknown-agent", "legacy sentinel");
    // Sessions: a legacy `claude` actor that should alias to `claude-code`,
    // plus an already-canonical one.
    store.startSession({ agent_id: "claude", title: "claude work", harness: "claude-code" });
    store.startSession({ agent_id: "codex", title: "codex work", harness: "codex" });
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  it("dry-run reports planned changes without mutating anything", () => {
    const { store } = s!;
    const report = backfillCallerIds(store, { aliases: BACKFILL_ALIASES });

    expect(report.apply).toBe(false);
    expect(report.memories.changes).toEqual(
      expect.arrayContaining([
        { from: "system", to: "system-migration", count: 2 },
        { from: "Claude Code", to: "claude-code", count: 1 },
      ]),
    );
    expect(report.sessions.changes).toEqual(
      expect.arrayContaining([{ from: "claude", to: "claude-code", count: 1 }]),
    );

    // Nothing changed on disk.
    expect(memoryAgentIds(store)).toEqual(
      ["Claude Code", "codex", "system", "unknown-agent"].sort(),
    );
    expect(sessionAgentIds(store).createdBy).toEqual(["claude", "codex"]);
  });

  it("apply reattributes memories and sessions to canonical ids", () => {
    const { store } = s!;
    const report = backfillCallerIds(store, { aliases: BACKFILL_ALIASES, apply: true });

    expect(report.apply).toBe(true);

    const mem = memoryAgentIds(store);
    expect(mem).toContain("system-migration");
    expect(mem).toContain("claude-code");
    expect(mem).toContain("codex");
    expect(mem).not.toContain("system");
    expect(mem).not.toContain("Claude Code");

    const sess = sessionAgentIds(store);
    expect(sess.createdBy).toEqual(["claude-code", "codex"]);
    expect(sess.current).toEqual(["claude-code", "codex"]);
  });

  it("never guesses the unknown-agent sentinel", () => {
    const { store } = s!;
    backfillCallerIds(store, { aliases: BACKFILL_ALIASES, apply: true });
    expect(memoryAgentIds(store)).toContain("unknown-agent");
  });

  it("is idempotent — a second apply makes no further changes", () => {
    const { store } = s!;
    backfillCallerIds(store, { aliases: BACKFILL_ALIASES, apply: true });
    const second = backfillCallerIds(store, { aliases: BACKFILL_ALIASES, apply: true });
    expect(second.memories.changes).toEqual([]);
    expect(second.sessions.changes).toEqual([]);
  });

  it("collapses two distinct source ids onto one target, idempotently", () => {
    const { store } = s!;
    // `bede` (alias) and `guybrush-hermes` (alias) plus a raw `Guybrush`
    // (pure normalisation) all resolve to `guybrush` — the §8 collision case.
    const aliases = { ...BACKFILL_ALIASES, bede: "guybrush", "guybrush-hermes": "guybrush" };
    seedMemory(store, "bede", "bede note");
    seedMemory(store, "guybrush-hermes", "hermes note");
    seedMemory(store, "Guybrush", "raw name");

    const report = backfillCallerIds(store, { aliases, apply: true });
    const guybrushChanges = report.memories.changes.filter((c) => c.to === "guybrush");
    expect(guybrushChanges.map((c) => c.from).sort()).toEqual(
      ["Guybrush", "bede", "guybrush-hermes"].sort(),
    );

    const mem = memoryAgentIds(store);
    expect(mem).toContain("guybrush");
    expect(mem).not.toContain("bede");
    expect(mem).not.toContain("guybrush-hermes");
    expect(mem).not.toContain("Guybrush");

    const second = backfillCallerIds(store, { aliases, apply: true });
    expect(second.memories.changes).toEqual([]);
  });

  it("records system-migration as the actor on the reattribution audit events", () => {
    const { store } = s!;
    backfillCallerIds(store, { aliases: BACKFILL_ALIASES, apply: true });
    const { events } = store.listEvents({ type: "memory.bulk_updated", limit: 100 });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.agent_id).toBe("system-migration");
    }
  });
});
