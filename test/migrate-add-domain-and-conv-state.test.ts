// T1.4 — backfill script for the memory-domain-isolation rollout.
//
// Exercises `scripts/migrate-add-domain-and-conv-state.mjs` end-to-end
// against a synthetic data directory. Asserts:
//
// - identity/relationship/preferences memories pick up the new booleans
//   and (for identity/relationship) the `profile` tag
// - agent_private memories land in a synthetic `legacy-private` domain
//   (created on the fly if any memory needs it)
// - sessions get `domain='general'`
// - dry-run vs --apply
// - idempotent across a second --apply run

import { exec as execCb } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type LibrarianStore, createLibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const exec = promisify(execCb);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "migrate-add-domain-and-conv-state.mjs");

interface Scope {
  dataDir: string;
  ids: {
    identity: string;
    relationship: string;
    preferences: string;
    tools: string;
    privateNote: string;
  };
  sessionId: string;
}

function makeScope(): Scope {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-domain-migrate-"));
  const store = createLibrarianStore({ dataDir });
  const ids = {
    identity: seed(store, "User identity", "identity", "common"),
    relationship: seed(store, "Working rapport", "relationship", "common"),
    preferences: seed(store, "Terse responses", "preferences", "common"),
    tools: seed(store, "pnpm test layout", "tools", "common"),
    privateNote: seed(store, "Codex scratch", "lessons", "agent_private"),
  };
  const { session } = store.startSession({
    agent_id: "codex",
    title: "Pre-migration session",
    harness: "claude-code",
  });
  const sessionId = session.id;
  // Wipe the post-T1.3 fields off the projection rows so the scenario
  // looks like an installation that predates this rollout.
  store.db.exec(
    "UPDATE memories SET domain='general', is_global=0, requires_approval=0; " +
      "UPDATE sessions SET domain='general';",
  );
  store.close();
  return { dataDir, ids, sessionId };
}

function seed(store: LibrarianStore, title: string, category: string, visibility: string): string {
  const created = store.createMemory({
    agent_id: "codex",
    title,
    body: `${title} — body pinned by migration test.`,
    category,
    visibility,
    scope: "global",
  });
  return created.memory.id;
}

async function runScript(dataDir: string, apply: boolean): Promise<string> {
  const cmd = `node --no-warnings ${JSON.stringify(scriptPath)} --data-dir ${JSON.stringify(
    dataDir,
  )}${apply ? " --apply" : ""}`;
  const { stdout, stderr } = await exec(cmd);
  return stdout + stderr;
}

describe("T1.4 — migrate-add-domain-and-conv-state script", () => {
  let scope: Scope | null = null;

  beforeEach(() => {
    scope = makeScope();
  });

  afterEach(() => {
    if (scope) fs.rmSync(scope.dataDir, { recursive: true, force: true });
    scope = null;
  });

  it("dry-run reports the planned counts without mutating the projection", async () => {
    const { dataDir, ids } = scope!;
    const stdout = await runScript(dataDir, false);
    expect(stdout).toMatch(/DRY-RUN/);
    expect(stdout).toMatch(/memories backfilled: 5/);
    expect(stdout).toMatch(/sessions backfilled: \d+/);
    expect(stdout).toMatch(/legacy-private memories: 1/);

    const store = createLibrarianStore({ dataDir });
    try {
      const row = store.db
        .prepare("SELECT is_global, requires_approval, domain FROM memories WHERE id = ?")
        .get(ids.identity) as { is_global: number; requires_approval: number; domain: string };
      expect(row.is_global).toBe(0);
      expect(row.requires_approval).toBe(0);
      expect(row.domain).toBe("general");
    } finally {
      store.close();
    }
  });

  it("applies derived booleans, domain assignment, and tag conversion", async () => {
    const { dataDir, ids } = scope!;
    const stdout = await runScript(dataDir, true);
    expect(stdout).toMatch(/APPLY/);

    const store = createLibrarianStore({ dataDir });
    try {
      const identity = store.getMemory(ids.identity);
      expect(identity.is_global).toBe(true);
      expect(identity.requires_approval).toBe(true);
      expect(identity.domain).toBe("general");
      expect(identity.tags).toContain("identity");
      expect(identity.tags).toContain("profile");

      const rel = store.getMemory(ids.relationship);
      expect(rel.is_global).toBe(true);
      expect(rel.requires_approval).toBe(true);
      expect(rel.tags).toContain("relationship");
      expect(rel.tags).toContain("profile");

      const pref = store.getMemory(ids.preferences);
      expect(pref.is_global).toBe(true);
      expect(pref.requires_approval).toBe(false);
      expect(pref.tags).toContain("preferences");
      expect(pref.tags).not.toContain("profile");

      const tools = store.getMemory(ids.tools);
      expect(tools.is_global).toBe(false);
      expect(tools.requires_approval).toBe(false);
      expect(tools.tags).toContain("tools");

      const priv = store.getMemory(ids.privateNote);
      expect(priv.domain).toBe("legacy-private");

      const domain = store.db
        .prepare("SELECT name FROM domains WHERE name = ?")
        .get("legacy-private");
      expect(domain).toBeTruthy();
    } finally {
      store.close();
    }
  });

  it("assigns domain='general' to sessions", async () => {
    const { dataDir, sessionId } = scope!;
    await runScript(dataDir, true);
    const store = createLibrarianStore({ dataDir });
    try {
      const row = store.db.prepare("SELECT domain FROM sessions WHERE id = ?").get(sessionId) as {
        domain: string;
      };
      expect(row.domain).toBe("general");
    } finally {
      store.close();
    }
  });

  it("is idempotent across a second --apply", async () => {
    const { dataDir, ids } = scope!;
    await runScript(dataDir, true);
    const first = readProjection(scope!);
    await runScript(dataDir, true);
    const second = readProjection(scope!);
    expect(second).toEqual(first);

    // Tags must not duplicate.
    const store = createLibrarianStore({ dataDir });
    try {
      const identity = store.getMemory(ids.identity);
      expect(identity.tags.filter((t: string) => t === "identity").length).toBe(1);
      expect(identity.tags.filter((t: string) => t === "profile").length).toBe(1);
    } finally {
      store.close();
    }
  });

  it("does not append new events to events.jsonl or session_events.jsonl", async () => {
    const { dataDir } = scope!;
    const eventsBefore = fs.readFileSync(path.join(dataDir, "events.jsonl"), "utf8");
    const sessionsBefore = fs.existsSync(path.join(dataDir, "session_events.jsonl"))
      ? fs.readFileSync(path.join(dataDir, "session_events.jsonl"), "utf8")
      : "";

    await runScript(dataDir, true);

    const eventsAfter = fs.readFileSync(path.join(dataDir, "events.jsonl"), "utf8");
    const sessionsAfter = fs.existsSync(path.join(dataDir, "session_events.jsonl"))
      ? fs.readFileSync(path.join(dataDir, "session_events.jsonl"), "utf8")
      : "";

    expect(eventsAfter).toBe(eventsBefore);
    expect(sessionsAfter).toBe(sessionsBefore);
  });
});

interface ProjectionSnapshot {
  memories: Array<{
    id: string;
    domain: string;
    is_global: number;
    requires_approval: number;
    tags_json: string;
  }>;
  sessions: Array<{ id: string; domain: string }>;
  domains: Array<{ name: string }>;
}

function readProjection(scope: Scope): ProjectionSnapshot {
  const store = createLibrarianStore({ dataDir: scope.dataDir });
  try {
    return {
      memories: store.db
        .prepare(
          "SELECT id, domain, is_global, requires_approval, tags_json FROM memories ORDER BY id",
        )
        .all() as ProjectionSnapshot["memories"],
      sessions: store.db
        .prepare("SELECT id, domain FROM sessions ORDER BY id")
        .all() as ProjectionSnapshot["sessions"],
      domains: store.db
        .prepare("SELECT name FROM domains ORDER BY name")
        .all() as ProjectionSnapshot["domains"],
    };
  } finally {
    store.close();
  }
}
