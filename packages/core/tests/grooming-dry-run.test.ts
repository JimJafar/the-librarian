// Grooming dry-run over the corpus with a candidate addendum (spec 044 D-4 / Task
// D4). Before an admin commits a new grooming addendum they want to SEE what it
// would do: run a CANDIDATE (uncommitted) addendum over the existing corpus in
// propose-mode, producing a reviewable batch of proposals WITHOUT committing the
// candidate addendum live and WITHOUT auto-applying anything.
//
// Network-free: a scripted LLM client makes the dry-run deterministic plumbing.
// Verifies: the candidate text reaches the prompt (capturing client); the live
// grooming-addendum.md file + status + version are UNCHANGED after a dry-run (the
// load-bearing invariant); nothing auto-applies even at confidence 1.0; proposals
// carry the dry-run tag (+ candidate label) and NOT addendum_version; a single
// slice runs synchronously; the whole-corpus path runs every affected slice.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type LlmClient,
  type Memory,
  addProvider,
  createLibrarianStore,
  dryRunGrooming,
  readAddendumStatus,
  resolveSecretKey,
  setAddendumStatus,
  setJobAddendum,
  writeConsumerConfig,
  writeGroomingConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Assemble the 64-hex key at runtime — no secret-shaped literal in source (GitGuardian).
const KEY = resolveSecretKey("0123456789abcdef".repeat(4));

let store: LibrarianStore | null = null;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-dryrun-"));
  store = createLibrarianStore({ dataDir, secretKey: KEY });
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

// An LLM client that emits one high-confidence create (would auto-apply when
// accepted; force-proposed under a dry-run). `title` makes the proposal findable;
// `projectKey` matches the slice so the create isn't rejected as cross-boundary.
function createEmittingClient(title: string, projectKey = "proj-x"): LlmClient {
  return {
    complete: async () => ({
      content: JSON.stringify({
        operations: [
          {
            type: "create",
            memory: {
              title,
              body: "a durable lesson",
              category: "lessons",
              visibility: "common",
              scope: "project",
              project_key: projectKey,
            },
            rationale: "novel durable lesson",
            confidence: 1.0,
          },
        ],
      }),
      model: "m",
      usage: null,
    }),
  };
}

function seedActive(title: string, projectKey = "proj-x") {
  store!.createMemory({
    agent_id: "agent-a",
    title,
    body: "b",
    category: "lessons",
    visibility: "common",
    scope: "project",
    project_key: projectKey,
    priority: "normal",
    confidence: "working",
  });
}

function configureGrooming(opts: { token?: string } = {}) {
  const provider = addProvider(store!, {
    name: "default",
    endpoint: "https://api.example.com/v1",
    ...(opts.token !== undefined ? { token: opts.token } : {}),
  });
  writeConsumerConfig(store!, "grooming", { providerId: provider.id, model: "gpt-x" });
}

function byTitle(title: string, status: string): Memory[] {
  return store!.listAll({ status }).filter((m) => m.title === title);
}

describe("dryRunGrooming — candidate addendum is never committed (the load-bearing invariant)", () => {
  it("leaves the live grooming addendum file, status, and version unchanged", async () => {
    seedActive("Active fact");
    writeGroomingConfig(store!, { enabled: true, defaultAutoApply: "high_confidence" });
    configureGrooming({ token: "dummy-decrypted-token" });
    // A committed, accepted live addendum.
    setJobAddendum(store!, "grooming", "LIVE committed guidance");
    const before = store!.readAddendum("grooming");
    const statusBefore = readAddendumStatus(store!, "grooming");

    const result = await dryRunGrooming({
      store: store!,
      candidateAddendum: "CANDIDATE uncommitted guidance",
      buildClient: () => createEmittingClient("Dry-run proposal"),
    });
    expect(result.ran).toBe(true);

    // The live file is byte-for-byte unchanged; status + version untouched.
    const after = store!.readAddendum("grooming");
    expect(after.content).toBe("LIVE committed guidance");
    expect(after.version).toBe(before.version);
    expect(readAddendumStatus(store!, "grooming")).toEqual(statusBefore);
    expect(readAddendumStatus(store!, "grooming").status).toBe("accepted");
  });
});

describe("dryRunGrooming — slice dry-run is synchronous + the candidate reaches the prompt", () => {
  it("runs one slice and the candidate addendum text reaches the LLM prompt", async () => {
    seedActive("Active fact");
    writeGroomingConfig(store!, { enabled: true, defaultAutoApply: "high_confidence" });
    configureGrooming({ token: "dummy-decrypted-token" });

    let seenPrompt = "";
    const capturingClient: LlmClient = {
      complete: async (request) => {
        seenPrompt = request.messages.map((m) => m.content).join("\n");
        return createEmittingClient("Dry-run proposal").complete(request);
      },
    };

    const result = await dryRunGrooming({
      store: store!,
      candidateAddendum: "CANDIDATE steering: prefer concise lessons",
      slice: { kind: "common_project", projectKey: "proj-x" },
      buildClient: () => capturingClient,
    });
    expect(result).toMatchObject({ ran: true, scope: "slice" });
    // The candidate text reached the prompt (redacted-passthrough — no secrets here).
    expect(seenPrompt).toContain("CANDIDATE steering: prefer concise lessons");
    expect(seenPrompt).toContain("OPERATOR GUIDANCE");
  });
});

describe("dryRunGrooming — proposals are tagged dry-run, nothing auto-applies", () => {
  it("forces every op to a proposal tagged dry-run (+ candidate label), even at confidence 1.0", async () => {
    seedActive("Active fact");
    writeGroomingConfig(store!, { enabled: true, defaultAutoApply: "high_confidence" });
    configureGrooming({ token: "dummy-decrypted-token" });

    await dryRunGrooming({
      store: store!,
      candidateAddendum: "CANDIDATE guidance",
      candidateLabel: "candidate v2",
      slice: { kind: "common_project", projectKey: "proj-x" },
      buildClient: () => createEmittingClient("Dry-run proposal"),
    });

    // The high-confidence create landed as a PROPOSAL, never active.
    const proposed = byTitle("Dry-run proposal", "proposed");
    expect(proposed).toHaveLength(1);
    expect(byTitle("Dry-run proposal", "active")).toEqual([]);
    // Tagged dry-run + candidate label; NOT tagged with an addendum_version.
    const note = proposed[0]?.curator_note as Record<string, unknown> | null | undefined;
    expect(note?.dry_run).toBe(true);
    expect(note?.dry_run_candidate).toBe("candidate v2");
    expect(note?.addendum_version).toBeUndefined();
  });

  it("dry-run proposals are distinguishable from a real grooming run's proposals", async () => {
    // A dry-run proposal carries dry_run; a normal (non-dry-run) run does not.
    // Use the store's own grooming run via runCuration semantics indirectly: assert
    // the dry-run tag is present here and absent on a hand-seeded plain proposal.
    seedActive("Active fact");
    writeGroomingConfig(store!, { enabled: true, defaultAutoApply: "high_confidence" });
    configureGrooming({ token: "dummy-decrypted-token" });

    // A plain proposal (no dry-run tag) as a real grooming run would produce.
    store!.createMemory(
      {
        agent_id: "agent-a",
        title: "Real proposal",
        body: "x",
        category: "lessons",
        visibility: "common",
        scope: "project",
        project_key: "proj-x",
      },
      { requires_approval: true, curator_note: { run_id: "r1" } },
    );

    await dryRunGrooming({
      store: store!,
      candidateAddendum: "CANDIDATE guidance",
      slice: { kind: "common_project", projectKey: "proj-x" },
      buildClient: () => createEmittingClient("Dry-run proposal"),
    });

    const real = byTitle("Real proposal", "proposed");
    expect(real).toHaveLength(1);
    const realNote = real[0]?.curator_note as Record<string, unknown> | null | undefined;
    expect(realNote?.dry_run).toBeUndefined();

    const dry = byTitle("Dry-run proposal", "proposed");
    const dryNote = dry[0]?.curator_note as Record<string, unknown> | null | undefined;
    expect(dryNote?.dry_run).toBe(true);
  });
});

describe("dryRunGrooming — whole-corpus path", () => {
  it("runs every slice that has curatable content (no slice given)", async () => {
    seedActive("Active X", "proj-x");
    seedActive("Active Y", "proj-y");
    writeGroomingConfig(store!, { enabled: true, defaultAutoApply: "high_confidence" });
    configureGrooming({ token: "dummy-decrypted-token" });

    // Emit a slice-specific proposal so we can confirm BOTH slices were judged.
    const client: LlmClient = {
      complete: async (request) => {
        const prompt = request.messages.map((m) => m.content).join("\n");
        const isX = prompt.includes("Active X");
        return createEmittingClient(
          isX ? "Dry-run X" : "Dry-run Y",
          isX ? "proj-x" : "proj-y",
        ).complete(request);
      },
    };

    const result = await dryRunGrooming({
      store: store!,
      candidateAddendum: "CANDIDATE guidance",
      buildClient: () => client,
    });
    expect(result).toMatchObject({ ran: true, scope: "corpus" });
    expect(byTitle("Dry-run X", "proposed").length).toBe(1);
    expect(byTitle("Dry-run Y", "proposed").length).toBe(1);
    // Active corpus untouched (nothing auto-applied / archived).
    expect(byTitle("Active X", "active").length).toBe(1);
    expect(byTitle("Active Y", "active").length).toBe(1);
  });

  it("is fail-soft: one slice's failure never wedges the rest", async () => {
    seedActive("Active X", "proj-x");
    seedActive("Active Y", "proj-y");
    writeGroomingConfig(store!, { enabled: true, defaultAutoApply: "high_confidence" });
    configureGrooming({ token: "dummy-decrypted-token" });

    const flakyClient: LlmClient = {
      complete: async (request) => {
        const prompt = request.messages.map((m) => m.content).join("\n");
        if (prompt.includes("Active Y")) throw new Error("simulated judge failure");
        return createEmittingClient("Dry-run X").complete(request);
      },
    };

    const result = await dryRunGrooming({
      store: store!,
      candidateAddendum: "CANDIDATE guidance",
      buildClient: () => flakyClient,
    });
    expect(result.ran).toBe(true);
    // proj-x still produced a proposal despite proj-y throwing.
    expect(byTitle("Dry-run X", "proposed").length).toBe(1);
  });
});

describe("dryRunGrooming — fail-soft gating", () => {
  it("does not run when grooming is disabled", async () => {
    seedActive("Active fact");
    writeGroomingConfig(store!, { enabled: false });
    configureGrooming({ token: "dummy-decrypted-token" });

    const result = await dryRunGrooming({
      store: store!,
      candidateAddendum: "CANDIDATE guidance",
      slice: { kind: "common_project", projectKey: "proj-x" },
      buildClient: () => createEmittingClient("Dry-run proposal"),
    });
    expect(result).toEqual({ ran: false, reason: "disabled" });
  });

  it("does not run when the token can't be decrypted", async () => {
    seedActive("Active fact");
    writeGroomingConfig(store!, { enabled: true });
    configureGrooming({ token: "dummy-secret" });
    store!.close();
    store = createLibrarianStore({ dataDir }); // reopen without the master key

    const result = await dryRunGrooming({
      store: store!,
      candidateAddendum: "CANDIDATE guidance",
      slice: { kind: "common_project", projectKey: "proj-x" },
      buildClient: () => createEmittingClient("Dry-run proposal"),
    });
    expect(result).toEqual({ ran: false, reason: "no_token" });
  });
});

// Independence from the job's real addendum_status: even with grooming under
// evaluation, a dry-run does not change that state and still force-proposes.
describe("dryRunGrooming — independent of the job's addendum_status", () => {
  it("does not change addendum_status and never auto-applies", async () => {
    seedActive("Active fact");
    writeGroomingConfig(store!, { enabled: true, defaultAutoApply: "high_confidence" });
    configureGrooming({ token: "dummy-decrypted-token" });
    setJobAddendum(store!, "grooming", "LIVE guidance");
    setAddendumStatus(store!, "grooming", "under_evaluation");
    const before = readAddendumStatus(store!, "grooming");

    await dryRunGrooming({
      store: store!,
      candidateAddendum: "CANDIDATE guidance",
      slice: { kind: "common_project", projectKey: "proj-x" },
      buildClient: () => createEmittingClient("Dry-run proposal"),
    });

    // Status (incl. the eval version) is unchanged by the dry-run.
    expect(readAddendumStatus(store!, "grooming")).toEqual(before);
    // The dry-run proposal is tagged dry-run, NOT with the live eval version.
    const note = byTitle("Dry-run proposal", "proposed")[0]?.curator_note as
      | Record<string, unknown>
      | null
      | undefined;
    expect(note?.dry_run).toBe(true);
    expect(note?.addendum_version).toBeUndefined();
  });
});
