// Post-intake grooming trigger — integration (spec 043 D-A). Grooming no longer
// runs on a wall-clock cron; after an intake sweep crosses
// curator.grooming.trigger_threshold (and outside the debounce window of the last
// groom), runIntakeTick enqueues exactly ONE grooming run tagged
// `trigger:"post_intake"`. These tests drive the REAL store: a real intake sweep
// files real memories, the real countAppliedOperationsSince + config + last-groom
// timestamp decide, and a real post_intake curation run is recorded. The grooming
// LLM is a network-free injected no-op so no provider is contacted.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type LlmClient,
  addProvider,
  createLibrarianStore,
  resolveSecretKey,
  runIntakeTick,
  runGroomingTick,
  setIntakeEnabled,
  writeConsumerConfig,
  writeGroomingConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Assemble the 64-hex master key at runtime — no secret-shaped literal in source.
const KEY = resolveSecretKey("0123456789abcdef".repeat(4));

let store: LibrarianStore | null = null;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-groom-trigger-"));
  store = createLibrarianStore({ dataDir, backend: "markdown", secretKey: KEY });
});
afterEach(() => {
  try {
    store?.close();
  } catch {
    /* ignore */
  }
  // The markdown backend runs git operations synchronously, but the OS
  // occasionally still has a transient handle on a file under .git/ when
  // we tear down (observed as `ENOTEMPTY: rmdir … vault/.git`). `force`
  // only swallows ENOENT, not ENOTEMPTY, so use the node-builtin retry
  // loop to ride out the race instead of letting it fail the suite.
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  store = null;
});

// An intake judge that files every submission as a fresh `create` (auto-applied at
// confidence ≥ 0.95 → an `applied` op in the decision log).
function createIntakeClient(): LlmClient {
  let n = 0;
  return {
    complete: async () => {
      n += 1;
      return {
        content: JSON.stringify({
          action: "create",
          title: `Topic ${n}`,
          body: `Body ${n}.`,
          tags: [],
          rationale: "novel topic",
          confidence: 0.97,
        }),
        model: "m",
        usage: null,
      };
    },
  };
}

// A grooming judge that proposes nothing — the run still records (a real post_intake
// curation run), but it makes no corpus change. Network-free.
const groomingNoOpClient: LlmClient = {
  complete: async () => ({ content: JSON.stringify({ operations: [] }), model: "m", usage: null }),
};

function configureIntake() {
  // The tick self-gates on curator.intake.enabled (spec 045 D-1), so enable it
  // here — these tests exercise an operational sweep + its post-intake trigger.
  setIntakeEnabled(store!, true);
  const provider = addProvider(store!, {
    name: "intake-provider",
    endpoint: "https://intake.example/v1",
    token: "dummy-intake-token",
  });
  writeConsumerConfig(store!, "intake", { providerId: provider.id, model: "gpt-x" });
}

function configureGrooming() {
  const provider = addProvider(store!, {
    name: "grooming-provider",
    endpoint: "https://grooming.example/v1",
    token: "dummy-grooming-token",
  });
  writeConsumerConfig(store!, "grooming", { providerId: provider.id, model: "gpt-y" });
  writeGroomingConfig(store!, { enabled: true });
}

// Seed a common-project memory so grooming has a due slice to run.
function seedMemory() {
  store!.createMemory({
    agent_id: "agent-a",
    title: "seed",
    body: "seed body",
    category: "lessons",
    visibility: "common",
    scope: "project",
    project_key: "proj-x",
    priority: "normal",
    confidence: "working",
  });
}

// A groom ENQUEUE spy: one call == one triggered groom (one runGroomingTick), which
// is the unit the spec means by "exactly one grooming run". A single enqueue may run
// several due slices (so several curation-run ROWS); the trigger fires once. We assert
// on the enqueue count, and separately that the resulting runs are tagged post_intake.
function groomSpy() {
  return vi.fn((s: LibrarianStore) =>
    runGroomingTick({ store: s, trigger: "post_intake", buildClient: () => groomingNoOpClient }),
  );
}

// Run an intake sweep that files `count` items, routing grooming through the
// network-free no-op client (via the injected triggerGrooming runner). `now` is the
// trigger's debounce-evaluation time (defaults to real now).
async function sweepFiling(
  count: number,
  runGroom: (s: LibrarianStore) => Promise<unknown>,
  now?: Date,
) {
  for (let i = 0; i < count; i += 1) store!.submitToInbox(`Submission ${i} ${Math.random()}`);
  return runIntakeTick({
    store: store!,
    buildClient: () => createIntakeClient(),
    triggerGrooming: runGroom,
    ...(now ? { now } : {}),
  });
}

function postIntakeRuns() {
  return store!.listCurationRuns().filter((r) => r.trigger === "post_intake");
}

describe("post-intake grooming trigger — threshold", () => {
  it("an intake burst crossing the threshold triggers grooming exactly once", async () => {
    seedMemory();
    configureIntake();
    configureGrooming();
    writeGroomingConfig(store!, { triggerThreshold: 3, debounceMinutes: 60 });

    const groom = groomSpy();
    const result = await sweepFiling(3, groom);

    expect(result).toMatchObject({ ran: true, summary: { consolidated: 3 } });
    // Exactly one enqueue — the trigger fired once.
    expect(groom).toHaveBeenCalledTimes(1);
    // …and every grooming run it produced is tagged post_intake.
    expect(postIntakeRuns().length).toBeGreaterThanOrEqual(1);
    expect(store!.listCurationRuns().every((r) => r.trigger === "post_intake")).toBe(true);
  });

  it("a sub-threshold intake burst does NOT trigger grooming", async () => {
    seedMemory();
    configureIntake();
    configureGrooming();
    writeGroomingConfig(store!, { triggerThreshold: 5, debounceMinutes: 60 });

    const groom = groomSpy();
    await sweepFiling(2, groom); // below the threshold of 5

    expect(groom).not.toHaveBeenCalled();
    expect(postIntakeRuns()).toHaveLength(0);
  });
});

describe("post-intake grooming trigger — debounce", () => {
  it("suppresses a second trigger within the debounce window", async () => {
    seedMemory();
    configureIntake();
    configureGrooming();
    writeGroomingConfig(store!, { triggerThreshold: 2, debounceMinutes: 60 });

    const groom = groomSpy();
    // First burst → one enqueue.
    await sweepFiling(2, groom);
    expect(groom).toHaveBeenCalledTimes(1);

    // Second burst immediately after, still inside the 60-min debounce → suppressed.
    await sweepFiling(2, groom);
    expect(groom).toHaveBeenCalledTimes(1); // still one — no second enqueue
  });

  it("allows a second trigger once the debounce window has elapsed", async () => {
    seedMemory();
    configureIntake();
    configureGrooming();
    writeGroomingConfig(store!, { triggerThreshold: 2, debounceMinutes: 1 });

    const groom = groomSpy();
    await sweepFiling(2, groom);
    expect(groom).toHaveBeenCalledTimes(1);

    // A second armed burst, evaluated 5 minutes later (> the 1-min debounce floor).
    await sweepFiling(2, groom, new Date(Date.now() + 5 * 60_000));
    expect(groom).toHaveBeenCalledTimes(2);
  });
});

describe("post-intake grooming trigger — fail-soft (intake is the hot path)", () => {
  it("a throwing grooming trigger does NOT fail the intake sweep", async () => {
    configureIntake();
    configureGrooming();
    writeGroomingConfig(store!, { triggerThreshold: 1 });
    store!.submitToInbox("a submission");

    const result = await runIntakeTick({
      store: store!,
      buildClient: () => createIntakeClient(),
      triggerGrooming: () => {
        throw new Error("groom enqueue boom");
      },
    });

    // The sweep still succeeded — the trigger failure was swallowed.
    expect(result).toMatchObject({ ran: true, summary: { consolidated: 1 } });
  });

  it("can be disabled entirely (triggerGrooming:false) — no groom enqueued", async () => {
    seedMemory();
    configureIntake();
    configureGrooming();
    writeGroomingConfig(store!, { triggerThreshold: 1 });
    store!.submitToInbox("a submission");

    await runIntakeTick({
      store: store!,
      buildClient: () => createIntakeClient(),
      triggerGrooming: false, // explicitly off — no groom, even above threshold
    });

    expect(postIntakeRuns()).toHaveLength(0);
  });
});
