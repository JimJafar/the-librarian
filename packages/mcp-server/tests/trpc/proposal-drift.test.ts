// Proposal drift over the wire — spec 072 T4/T5 (SC 5, SC 6).
//
// End-to-end through the real HTTP bin: a proposal records digests of the
// memories it supersedes when drafted; if one of those memories changes while
// the proposal waits in the queue, review says so and approve REFUSES.
//
// D3: hard block, no override. Rejecting is the only exit, and the refusal has
// to say why that costs nothing — the curator re-reads the memory on its next
// grooming run and may well propose a similar change against the new version.
// Without that sentence the operator reads a refusal as losing the curator's
// work and goes looking for a way around it.

import { createLibrarianStore, memoryContentDigest } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

interface MemoryRow {
  id: string;
  title: string;
  body: string;
  status: string;
}

interface SourceDrift {
  id: string;
  title: string | null;
  drifted: boolean;
}

interface ReviewRow {
  proposal: MemoryRow;
  action: string | null;
  targets: MemoryRow[];
  drift: { status: "clean" | "drifted" | "unknown"; sources: SourceDrift[] };
}

interface ServerHandle {
  trpcUrl: string;
  token: string;
  stop: () => Promise<void>;
}

interface TrpcOk<T> {
  result: { data: T };
}

async function trpcGet<T>(server: ServerHandle, path: string): Promise<T> {
  const response = await fetch(new URL(`${server.trpcUrl}/trpc/${path}`), {
    headers: { authorization: `Bearer ${server.token}` },
  });
  const json = (await response.json()) as TrpcOk<T> | { error: unknown };
  if (response.status >= 400 || "error" in json) {
    throw new Error(`trpc GET ${path} failed: ${JSON.stringify(json)}`);
  }
  return (json as TrpcOk<T>).result.data;
}

/** POST that returns the raw envelope, so a test can assert on the error. */
async function trpcPostRaw(
  server: ServerHandle,
  path: string,
  input: unknown,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${server.trpcUrl}/trpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
    body: JSON.stringify(input),
  });
  return { status: response.status, body: await response.text() };
}

function seedMemory(dataDir: string, title: string, body: string): MemoryRow {
  const store = createLibrarianStore({ dataDir });
  try {
    return store.createMemory({ agent_id: "bede", title, body }).memory as MemoryRow;
  } finally {
    store.close();
  }
}

/** A grooming-style proposal superseding `sources`, digested as they are NOW. */
function seedProposal(dataDir: string, sources: MemoryRow[], stampDigests = true): MemoryRow {
  const store = createLibrarianStore({ dataDir });
  try {
    const curatorNote: Record<string, unknown> = {
      proposed_action: "update",
      source: "grooming",
      rationale: "tightened the wording",
      supersedes: sources.map((s) => s.id),
    };
    if (stampDigests) {
      curatorNote.source_digests = Object.fromEntries(
        sources.map((s) => [s.id, memoryContentDigest(s)]),
      );
    }
    return store.createMemory(
      { agent_id: "scribe", title: sources[0]!.title, body: "the curator's replacement text" },
      { requires_approval: true, curator_note: curatorNote },
    ).memory as MemoryRow;
  } finally {
    store.close();
  }
}

function editMemory(dataDir: string, id: string, body: string): void {
  const store = createLibrarianStore({ dataDir });
  try {
    store.updateMemory(id, { body });
  } finally {
    store.close();
  }
}

function statusOf(dataDir: string, id: string): string | undefined {
  const store = createLibrarianStore({ dataDir });
  try {
    return store.getMemory(id)?.status;
  } finally {
    store.close();
  }
}

describe("proposal drift on the review row (spec 072 SC 5)", () => {
  it("reports clean while the source is untouched", async () => {
    const dataDir = makeTempDir();
    const target = seedMemory(dataDir, "Deploy policy", "never deploy on a Friday");
    seedProposal(dataDir, [target]);
    const server = await startHttpServer({ dataDir });
    try {
      const [row] = await trpcGet<ReviewRow[]>(server, "memories.proposalsForReview");
      expect(row!.drift.status).toBe("clean");
      expect(row!.drift.sources).toEqual([
        { id: target.id, title: "Deploy policy", drifted: false },
      ]);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("reports drifted once the source is edited", async () => {
    const dataDir = makeTempDir();
    const target = seedMemory(dataDir, "Deploy policy", "never deploy on a Friday");
    seedProposal(dataDir, [target]);
    editMemory(dataDir, target.id, "never deploy after 3pm on a Friday");
    const server = await startHttpServer({ dataDir });
    try {
      const [row] = await trpcGet<ReviewRow[]>(server, "memories.proposalsForReview");
      expect(row!.drift.status).toBe("drifted");
      expect(row!.drift.sources[0]!.drifted).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("reports unknown for a proposal drafted before digests existed", async () => {
    const dataDir = makeTempDir();
    const target = seedMemory(dataDir, "Deploy policy", "never deploy on a Friday");
    seedProposal(dataDir, [target], false);
    const server = await startHttpServer({ dataDir });
    try {
      const [row] = await trpcGet<ReviewRow[]>(server, "memories.proposalsForReview");
      expect(row!.drift.status).toBe("unknown");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});

describe("approve refuses a drifted proposal (spec 072 SC 6)", () => {
  it("refuses, names the changed memory, and promises the curator will re-read it", async () => {
    const dataDir = makeTempDir();
    const target = seedMemory(dataDir, "Deploy policy", "never deploy on a Friday");
    const proposal = seedProposal(dataDir, [target]);
    editMemory(dataDir, target.id, "never deploy after 3pm on a Friday");
    const server = await startHttpServer({ dataDir });
    try {
      const refusal = await trpcPostRaw(server, "memories.approve", { id: proposal.id });

      expect(refusal.status).toBeGreaterThanOrEqual(400);
      expect(refusal.body).toContain("CONFLICT");
      // Names what moved, so the operator knows which edit is at stake.
      expect(refusal.body).toContain("Deploy policy");
      // The reassurance that makes a hard block acceptable (D3).
      expect(refusal.body).toMatch(/grooming run/i);

      // Nothing happened: the proposal is still open and the source still live.
      expect(statusOf(dataDir, proposal.id)).toBe("proposed");
      expect(statusOf(dataDir, target.id)).toBe("active");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("still approves a clean proposal", async () => {
    const dataDir = makeTempDir();
    const target = seedMemory(dataDir, "Deploy policy", "never deploy on a Friday");
    const proposal = seedProposal(dataDir, [target]);
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPostRaw(server, "memories.approve", { id: proposal.id });
      expect(result.status).toBeLessThan(400);
      expect(statusOf(dataDir, proposal.id)).toBe("active");
      expect(statusOf(dataDir, target.id)).toBe("archived");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("does not block a legacy proposal that carries no digests", async () => {
    const dataDir = makeTempDir();
    const target = seedMemory(dataDir, "Deploy policy", "never deploy on a Friday");
    const proposal = seedProposal(dataDir, [target], false);
    editMemory(dataDir, target.id, "edited since — but nothing recorded the old text");
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPostRaw(server, "memories.approve", { id: proposal.id });
      expect(result.status).toBeLessThan(400);
      expect(statusOf(dataDir, proposal.id)).toBe("active");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("does not block rejecting a drifted proposal — reject is the way out", async () => {
    const dataDir = makeTempDir();
    const target = seedMemory(dataDir, "Deploy policy", "never deploy on a Friday");
    const proposal = seedProposal(dataDir, [target]);
    editMemory(dataDir, target.id, "never deploy after 3pm on a Friday");
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPostRaw(server, "memories.reject", { id: proposal.id });
      expect(result.status).toBeLessThan(400);
      expect(statusOf(dataDir, proposal.id)).toBe("archived");
      expect(statusOf(dataDir, target.id)).toBe("active");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
