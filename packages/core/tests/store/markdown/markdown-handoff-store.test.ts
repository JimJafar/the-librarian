// Markdown HandoffStore tests (plan 036 Phase 2 / spec 035 §F9). Mirrors the
// SQLite handoff-store contract: store → list (unclaimed) → claim → list
// (gone) → re-claim 409; 404 on unknown; project/cwd filtering; includeClaimed;
// getById; purge. Each handoff is a `handoffs/<id>.md` file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type HandoffStore,
  HandoffAlreadyClaimedError,
  HandoffNotFoundError,
  createMarkdownHandoffStore,
  createVault,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-md-handoff-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const validDoc = [
  "## Start & intent",
  "do the thing.",
  "## Journey",
  "tried X then Y.",
  "## Current state",
  "green tests.",
  "## What's left",
  "ship it.",
  "## Open questions",
  "none.",
].join("\n\n");

function setup() {
  const vault = createVault({ dataDir });
  let counter = 0;
  const store: HandoffStore = createMarkdownHandoffStore({
    vault,
    generateId: () => `hdo_t${++counter}`,
  });
  const input = (over: Partial<{ project_key: string; cwd: string; harness: string }> = {}) => ({
    title: "Continue the migration",
    document_md: validDoc,
    project_key: over.project_key ?? "proj-x",
    cwd: over.cwd ?? "/repo",
    harness: over.harness ?? "claude-code",
    tags: ["migration"],
  });
  const ctx = (agent: string | null = "agent-a") => ({ created_by_agent_id: agent });
  return { vault, store, input, ctx };
}

describe("markdown HandoffStore", () => {
  it("stores → lists → claims → drops from the unclaimed list → re-claim 409", () => {
    const { store, input, ctx } = setup();
    const { handoff_id } = store.store(input(), ctx());

    const listed = store.list({ project_key: "proj-x", cwd: "/repo" }, {});
    expect(listed.map((h) => h.handoff_id)).toEqual([handoff_id]);
    expect(listed[0]!.tags).toEqual(["migration"]);

    const claimed = store.claim({
      handoff_id,
      claiming_agent_id: "agent-b",
      claiming_harness: "codex",
    });
    expect(claimed.document_md).toContain("ship it");
    expect(claimed.claimed_at).toBeTruthy();

    expect(store.list({ project_key: "proj-x", cwd: "/repo" }, {})).toHaveLength(0);
    expect(() => store.claim({ handoff_id })).toThrow(HandoffAlreadyClaimedError);
  });

  it("only one of two back-to-back claims wins (sync atomicity)", () => {
    const { store, input, ctx } = setup();
    const { handoff_id } = store.store(input(), ctx());
    let won = 0;
    let lost = 0;
    for (let i = 0; i < 2; i++) {
      try {
        store.claim({ handoff_id });
        won++;
      } catch (error) {
        if (error instanceof HandoffAlreadyClaimedError) lost++;
        else throw error;
      }
    }
    expect([won, lost]).toEqual([1, 1]);
  });

  it("throws HandoffNotFoundError when claiming an unknown id", () => {
    const { store } = setup();
    expect(() => store.claim({ handoff_id: "hdo_ghost" })).toThrow(HandoffNotFoundError);
  });

  it("filters by project_key + cwd (both must match)", () => {
    const { store, input, ctx } = setup();
    store.store(input({ project_key: "proj-x", cwd: "/a" }), ctx());
    expect(store.list({ project_key: "proj-x", cwd: "/b" }, {})).toHaveLength(0);
    expect(store.list({ cwd: "/a" }, {})).toHaveLength(1);
  });

  it("includeClaimed surfaces claimed handoffs for admin views", () => {
    const { store, input, ctx } = setup();
    const { handoff_id } = store.store(input(), ctx());
    store.claim({ handoff_id });
    expect(store.list({}, {})).toHaveLength(0);
    expect(store.list({}, { includeClaimed: true })).toHaveLength(1);
    expect(store.listDetails({}, { includeClaimed: true })[0]!.claimed_by).toEqual({
      agent_id: null,
      harness: null,
      source_ref: null,
      cwd: null,
    });
  });

  it("lists newest-first by created_at and filters by harness", () => {
    const vault = createVault({ dataDir });
    const times = [
      "2026-06-01T00:00:00.000Z",
      "2026-06-03T00:00:00.000Z",
      "2026-06-02T00:00:00.000Z",
    ];
    let i = 0;
    let n = 0;
    const store = createMarkdownHandoffStore({
      vault,
      now: () => times[i++] ?? "2026-06-04T00:00:00.000Z",
      generateId: () => `hdo_o${++n}`,
    });
    const mk = (harness: string) => ({ title: "Handoff title", document_md: validDoc, harness });
    store.store(mk("claude-code"), { created_by_agent_id: null }); // o1 @ 06-01
    store.store(mk("codex"), { created_by_agent_id: null }); // o2 @ 06-03
    store.store(mk("claude-code"), { created_by_agent_id: null }); // o3 @ 06-02
    expect(store.list({}, {}).map((h) => h.handoff_id)).toEqual(["hdo_o2", "hdo_o3", "hdo_o1"]);
    expect(store.list({ harness: "codex" }, {}).map((h) => h.handoff_id)).toEqual(["hdo_o2"]);
  });

  it("getById returns full detail or null; purge hard-deletes idempotently", () => {
    const { store, input, ctx } = setup();
    const { handoff_id } = store.store({ ...input(), source_ref: "ref://abc" }, ctx());
    const detail = store.getById(handoff_id);
    expect(detail?.source_ref).toBe("ref://abc");
    expect(detail?.claimed_at).toBeNull();
    expect(store.getById("hdo_ghost")).toBeNull();

    expect(store.purge(handoff_id)).toBe(true);
    expect(store.getById(handoff_id)).toBeNull();
    expect(store.purge(handoff_id)).toBe(false);
  });
});
