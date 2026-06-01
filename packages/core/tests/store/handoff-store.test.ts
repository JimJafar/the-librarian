// Handoff store tests (sessions-rethink spec §6.2 + §7).
//
// Pin the contract the MCP tools depend on:
//   - store → list → claim → list (no longer surfaces) → claim again → 409.
//   - server-scoped domain isolation: a handoff in domain A never lists for B.
//   - user-facing project/cwd filtering when both are supplied.
//   - concurrent claim: parallel attempts pick a single winner.
//   - 404 vs 409 distinguish on the claim path.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  HandoffAlreadyClaimedError,
  HandoffNotFoundError,
  createLibrarianStore,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Scope {
  store: LibrarianStore;
  handoffs: LibrarianStore["handoffs"];
  dataDir: string;
}

let s: Scope | null = null;

beforeEach(() => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-handoff-"));
  const store = createLibrarianStore({ dataDir });
  s = { store, handoffs: store.handoffs, dataDir };
});

afterEach(() => {
  if (!s) return;
  try {
    s.store.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(s.dataDir, { recursive: true, force: true });
  s = null;
});

const validDoc = `# Handoff: test

## Start & intent
do the thing.

## Journey
tried X then Y.

## Current state
green tests.

## What's left
ship it.

## Open questions
none.
`;

function defaultInput(
  over: Partial<{
    title: string;
    document_md: string;
    project_key: string | null;
    cwd: string | null;
    harness: string | null;
    tags: string[];
  }> = {},
) {
  return {
    title: "a valid title",
    document_md: validDoc,
    project_key: "proj-x",
    cwd: "/repo",
    harness: "claude-code",
    tags: ["migration"],
    ...over,
  };
}

const ctx = (domain = "general", agent = "agent-a") => ({
  domain,
  created_by_agent_id: agent,
});

describe("handoff store — happy path", () => {
  it("stores, lists, and claims a handoff in a single round-trip", () => {
    const { handoffs } = s!;
    const stored = handoffs.store(defaultInput(), ctx());
    expect(stored.handoff_id).toMatch(/^hdo_/);

    const listed = handoffs.list({ project_key: "proj-x", cwd: "/repo" }, { domain: "general" });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.handoff_id).toBe(stored.handoff_id);
    expect(listed[0]!.title).toBe("a valid title");
    expect(listed[0]!.tags).toEqual(["migration"]);

    const claimed = handoffs.claim(
      { handoff_id: stored.handoff_id, claiming_agent_id: "agent-b", claiming_harness: "codex" },
      { domain: "general" },
    );
    expect(claimed.document_md).toContain("ship it");

    const after = handoffs.list({ project_key: "proj-x", cwd: "/repo" }, { domain: "general" });
    expect(after).toHaveLength(0);
  });

  it("rejects a second claim with HandoffAlreadyClaimedError", () => {
    const { handoffs } = s!;
    const stored = handoffs.store(defaultInput(), ctx());
    handoffs.claim({ handoff_id: stored.handoff_id }, { domain: "general" });
    expect(() => handoffs.claim({ handoff_id: stored.handoff_id }, { domain: "general" })).toThrow(
      HandoffAlreadyClaimedError,
    );
  });

  it("rejects a missing id with HandoffNotFoundError", () => {
    const { handoffs } = s!;
    expect(() => handoffs.claim({ handoff_id: "hdo_ghost" }, { domain: "general" })).toThrow(
      HandoffNotFoundError,
    );
  });
});

describe("handoff store — domain isolation", () => {
  it("never lists a handoff stored in another domain", () => {
    const { handoffs } = s!;
    handoffs.store(defaultInput({ project_key: null, cwd: null }), ctx("domain-a"));
    expect(handoffs.list({}, { domain: "domain-b" })).toHaveLength(0);
    expect(handoffs.list({}, { domain: "domain-a" })).toHaveLength(1);
  });

  it("treats a claim across domains as 404, not 409", () => {
    const { handoffs } = s!;
    const stored = handoffs.store(defaultInput(), ctx("domain-a"));
    expect(() => handoffs.claim({ handoff_id: stored.handoff_id }, { domain: "domain-b" })).toThrow(
      HandoffNotFoundError,
    );
  });
});

describe("handoff store — project + cwd filtering", () => {
  it("returns nothing when project_key matches but cwd does not", () => {
    const { handoffs } = s!;
    handoffs.store(defaultInput({ project_key: "proj-x", cwd: "/a" }), ctx());
    expect(handoffs.list({ project_key: "proj-x", cwd: "/b" }, { domain: "general" })).toHaveLength(
      0,
    );
  });

  it("ignores an axis when its filter is null/undefined", () => {
    const { handoffs } = s!;
    handoffs.store(defaultInput({ project_key: "proj-x", cwd: "/a" }), ctx());
    // No project filter → matches.
    expect(handoffs.list({ cwd: "/a" }, { domain: "general" })).toHaveLength(1);
    // Project filter unrelated → no match.
    expect(handoffs.list({ project_key: "proj-y" }, { domain: "general" })).toHaveLength(0);
  });
});

describe("handoff store — concurrent claim", () => {
  it("only one claim succeeds when two attempts run back-to-back", () => {
    const { handoffs } = s!;
    const stored = handoffs.store(defaultInput(), ctx());
    let won = 0;
    let lost = 0;
    for (let i = 0; i < 2; i++) {
      try {
        handoffs.claim({ handoff_id: stored.handoff_id }, { domain: "general" });
        won++;
      } catch (error) {
        if (error instanceof HandoffAlreadyClaimedError) lost++;
        else throw error;
      }
    }
    expect(won).toBe(1);
    expect(lost).toBe(1);
  });
});

describe("handoff store — admin / cross-domain access", () => {
  it("lists across every domain when context.domain is null (admin bypass)", () => {
    const { handoffs } = s!;
    handoffs.store(defaultInput(), ctx("domain-a"));
    handoffs.store(defaultInput(), ctx("domain-b"));
    expect(handoffs.list({}, { domain: null })).toHaveLength(2);
  });

  it("claims across domains when context.domain is null", () => {
    const { handoffs } = s!;
    const stored = handoffs.store(defaultInput(), ctx("domain-a"));
    const claimed = handoffs.claim({ handoff_id: stored.handoff_id }, { domain: null });
    expect(claimed.handoff_id).toBe(stored.handoff_id);
  });

  it("includes already-claimed rows when context.includeClaimed is true", () => {
    const { handoffs } = s!;
    const stored = handoffs.store(defaultInput(), ctx());
    handoffs.claim({ handoff_id: stored.handoff_id }, { domain: "general" });
    expect(handoffs.list({}, { domain: "general" })).toHaveLength(0);
    expect(handoffs.list({}, { domain: "general", includeClaimed: true })).toHaveLength(1);
  });
});

describe("handoff store — purge (admin / test)", () => {
  it("hard-deletes a handoff and reports whether anything was removed", () => {
    const { handoffs } = s!;
    const stored = handoffs.store(defaultInput(), ctx());
    expect(handoffs.purge(stored.handoff_id)).toBe(true);
    expect(handoffs.purge(stored.handoff_id)).toBe(false);
  });
});

describe("handoff store — getById (admin / dashboard detail)", () => {
  it("returns the full detail for a stored handoff, with null claim fields", () => {
    const { handoffs } = s!;
    const stored = handoffs.store(
      { ...defaultInput(), source_ref: "ref://origin/abc" },
      ctx("general", "agent-a"),
    );

    const detail = handoffs.getById(stored.handoff_id);
    expect(detail).not.toBeNull();
    expect(detail!.handoff_id).toBe(stored.handoff_id);
    expect(detail!.title).toBe("a valid title");
    expect(detail!.document_md).toContain("ship it");
    expect(detail!.project_key).toBe("proj-x");
    expect(detail!.source_ref).toBe("ref://origin/abc");
    expect(detail!.cwd).toBe("/repo");
    expect(detail!.created_in_harness).toBe("claude-code");
    expect(detail!.created_by_agent_id).toBe("agent-a");
    expect(detail!.domain).toBe("general");
    expect(detail!.tags).toEqual(["migration"]);
    expect(detail!.created_at).toBe(stored.created_at);
    expect(detail!.claimed_at).toBeNull();
    expect(detail!.claimed_by).toBeNull();
  });

  it("returns null for an unknown id", () => {
    const { handoffs } = s!;
    expect(handoffs.getById("hdo_ghost")).toBeNull();
  });

  it("surfaces claim metadata after a claim", () => {
    const { handoffs } = s!;
    const stored = handoffs.store(defaultInput(), ctx());
    handoffs.claim(
      { handoff_id: stored.handoff_id, claiming_agent_id: "agent-b", claiming_harness: "codex" },
      { domain: "general" },
    );
    const detail = handoffs.getById(stored.handoff_id);
    expect(detail!.claimed_at).not.toBeNull();
    expect(detail!.claimed_by).toEqual({
      agent_id: "agent-b",
      harness: "codex",
      source_ref: null,
      cwd: null,
    });
  });

  it("looks up by id regardless of domain (no domain scoping)", () => {
    const { handoffs } = s!;
    const stored = handoffs.store(defaultInput({ project_key: null, cwd: null }), ctx("domain-a"));
    const detail = handoffs.getById(stored.handoff_id);
    expect(detail!.domain).toBe("domain-a");
  });
});
