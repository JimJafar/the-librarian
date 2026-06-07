// Intake decision log (spec 043 C1). The intake sweep records a
// full-outcome decision log (run + per-op rows) into the intake sidecar,
// WITHOUT changing filing. These are the spec's acceptance criteria:
//   1. a sweep that files N items leaves N logged operations queryable;
//   2. a forced log-write failure does NOT fail the sweep;
//   3. filing behaviour is byte-identical with and without logging.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type IntakeLogger,
  type IntakeStore,
  type IntakeApplyStore,
  type LlmClient,
  type LlmCompletionRequest,
  type Vault,
  createJsonIntakeStore,
  createVault,
  runIntakeSweep,
  writeInbox,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let vault: Vault;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-decision-log-"));
  vault = createVault({ dataDir });
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const CREATE_JUDGMENT = JSON.stringify({
  action: "create",
  title: "T",
  body: "B",
  tags: [],
  rationale: "novel topic",
  confidence: 0.97,
});

// A judge that auto-applies an augment (confidence ≥ 0.95) against target m1.
const AUGMENT_JUDGMENT = JSON.stringify({
  action: "augment",
  target_id: "m1",
  addition: "more",
  rationale: "weaves in",
  confidence: 0.97,
});

// A mid-band augment (0.85–0.95) → routed to a PROPOSE (filed as a fresh proposed doc).
const PROPOSE_JUDGMENT = JSON.stringify({
  action: "augment",
  target_id: "m1",
  addition: "maybe",
  rationale: "uncertain merge",
  confidence: 0.9,
});

const NOOP_JUDGMENT = JSON.stringify({
  action: "noop",
  rationale: "duplicate",
  confidence: 0.5,
});

function fakeStore(): IntakeApplyStore {
  let n = 0;
  return {
    createMemory: () => ({ memory: { id: `mem_${n++}` } }),
    updateMemory: () => null,
    archiveMemory: () => null,
    // Return a stored memory so augment/supersede/archive targets exist.
    getMemory: () => ({ title: "Existing", body: "Existing body." }),
  };
}

function constantClient(content: string): LlmClient {
  return { complete: async () => ({ content, model: "x", usage: null }) };
}

function deps(client: LlmClient, extra: Record<string, unknown> = {}) {
  return {
    vault,
    recall: async () => [],
    listActive: () => [],
    llmClient: client,
    store: fakeStore(),
    actorId: "system-consolidator",
    ...extra,
  };
}

function write(text: string, ms: number, id: string) {
  return writeInbox(vault, text, { now: () => ms, generateId: () => id });
}

function logStore(): IntakeStore {
  return createJsonIntakeStore({
    filePath: path.join(dataDir, "consolidation-runs.json"),
  });
}

describe("intake decision log — full-outcome coverage", () => {
  it("a sweep that files N items leaves N logged operations queryable", async () => {
    write("first", 1000, "a");
    write("second", 1001, "b");
    write("third", 1002, "c");
    const store = logStore();

    const summary = await runIntakeSweep(
      deps(constantClient(CREATE_JUDGMENT), {
        intakeLog: store,
        intakeTrigger: "tick",
      }),
    );

    expect(summary.consolidated).toBe(3);
    const runs = store.listIntakeRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "tick", status: "completed", consolidated: 3 });
    const ops = store.getIntakeOperations(runs[0]!.id);
    expect(ops).toHaveLength(3); // N items → N logged operations
    expect(ops.every((o) => o.outcome === "applied" && o.action === "create")).toBe(true);
    expect(ops.every((o) => o.confidence === 0.97)).toBe(true);
    expect(ops.every((o) => o.source_id?.startsWith("inbox/.processing/"))).toBe(true);
  });

  it("records every outcome — applied, proposed AND skipped — not just auto-applies", async () => {
    write("create-me", 1000, "a");
    write("propose-me", 1001, "b");
    write("skip-me", 1002, "c");
    const store = logStore();
    // Route by submission text: create (applied), mid-band augment (proposed), noop (skipped).
    const client: LlmClient = {
      complete: async (req: LlmCompletionRequest) => {
        const sub = req.messages[1]?.content ?? "";
        if (sub.includes("propose-me"))
          return { content: PROPOSE_JUDGMENT, model: "x", usage: null };
        if (sub.includes("skip-me")) return { content: NOOP_JUDGMENT, model: "x", usage: null };
        return { content: CREATE_JUDGMENT, model: "x", usage: null };
      },
    };

    await runIntakeSweep(deps(client, { intakeLog: store, intakeTrigger: "tick" }));

    const ops = store.getIntakeOperations(store.listIntakeRuns()[0]!.id);
    expect(ops.map((o) => o.outcome).sort()).toEqual(["applied", "proposed", "skipped"]);
  });

  it("logs the target_id for an applied augment", async () => {
    write("augment-me", 1000, "a");
    const store = logStore();
    await runIntakeSweep(deps(constantClient(AUGMENT_JUDGMENT), { intakeLog: store }));
    const ops = store.getIntakeOperations(store.listIntakeRuns()[0]!.id);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ action: "augment", outcome: "applied", target_id: "m1" });
  });

  it("logs an intake split as a PROPOSED op (action=split, target=the split source)", async () => {
    // A high-confidence split must still land as a `proposed` row in the log —
    // never `applied` (spec 043 D-B: intake split is never auto-applied).
    const SPLIT_JUDGMENT = JSON.stringify({
      action: "split",
      target_id: "m1", // fakeStore.getMemory returns a doc for any id → target exists
      replacements: [
        { title: "Anna", body: "About Anna." },
        { title: "Bob", body: "About Bob." },
      ],
      rationale: "the candidate doc conflates two people",
      confidence: 0.99,
    });
    write("split-me", 1000, "a");
    const store = logStore();
    await runIntakeSweep(deps(constantClient(SPLIT_JUDGMENT), { intakeLog: store }));
    const ops = store.getIntakeOperations(store.listIntakeRuns()[0]!.id);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ action: "split", outcome: "proposed", target_id: "m1" });
    expect(ops[0]?.source_id?.startsWith("inbox/.processing/")).toBe(true);
  });

  it("redacts a secret-shaped rationale before logging it", async () => {
    write("create-me", 1000, "a");
    const store = logStore();
    // A model rationale carrying a `key = secret` assignment must be redacted in
    // the log (the same known-format redactor apply.ts uses to scrub the vault).
    // The literal is assembled at runtime so no secret-shaped string sits in source.
    const secret = "s3cr3t-value-here";
    const leaky = JSON.stringify({
      action: "create",
      title: "T",
      body: "B",
      tags: [],
      rationale: `set ${"api_key"} = "${secret}" then file`,
      confidence: 0.97,
    });
    await runIntakeSweep(deps(constantClient(leaky), { intakeLog: store }));
    const ops = store.getIntakeOperations(store.listIntakeRuns()[0]!.id);
    expect(ops[0]?.rationale).not.toContain(secret);
    expect(ops[0]?.rationale).toContain("[REDACTED:secret]");
  });
});

describe("intake decision log — fail-soft (load-bearing)", () => {
  // A logger whose every method throws — modelling a corrupt/locked sidecar.
  function throwingLogger(): IntakeLogger {
    const boom = (): never => {
      throw new Error("log write failed");
    };
    return {
      createIntakeRun: boom,
      recordIntakeOperation: boom,
      startIntakeRun: boom,
      completeIntakeRun: boom,
      failIntakeRun: boom,
    };
  }

  it("a forced log-write failure does NOT fail the sweep (sweep still completes + returns its summary)", async () => {
    write("first", 1000, "a");
    write("second", 1001, "b");
    const logErrors: unknown[] = [];

    const summary = await runIntakeSweep(
      deps(constantClient(CREATE_JUDGMENT), {
        intakeLog: throwingLogger(),
        intakeTrigger: "tick",
        logError: (e: unknown) => logErrors.push(e),
      }),
    );

    // The sweep completed normally — both items filed — despite the logger throwing.
    expect(summary.consolidated).toBe(2);
    expect(summary.errored).toBe(0);
    // The swallowed log failures were surfaced to the debug sink, never thrown.
    expect(logErrors.length).toBeGreaterThan(0);
  });

  it("an operation-record throw on one item still files the rest of the batch", async () => {
    write("first", 1000, "a");
    write("second", 1001, "b");
    write("third", 1002, "c");
    // Only the per-op record throws; run open/complete succeed.
    let calls = 0;
    const logger: IntakeLogger = {
      ...logStore(),
      recordIntakeOperation: () => {
        calls++;
        throw new Error("op write failed");
      },
    };

    const summary = await runIntakeSweep(
      deps(constantClient(CREATE_JUDGMENT), { intakeLog: logger }),
    );

    expect(summary.consolidated).toBe(3); // all three filed despite every op-write throwing
    expect(calls).toBe(3); // it was attempted for each
  });
});

describe("intake decision log — byte-identical filing", () => {
  it("produces the same sweep summary with and without a logger", async () => {
    // Run A: no logger.
    const a = await runIntakeSweep(deps(constantClient(CREATE_JUDGMENT)));
    fs.rmSync(dataDir, { recursive: true, force: true });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-decision-log-b-"));
    vault = createVault({ dataDir });

    // Run B: with a logger, identical inputs.
    const store = logStore();
    const b = await runIntakeSweep(deps(constantClient(CREATE_JUDGMENT), { intakeLog: store }));

    // Both empty inboxes → identical no-op summary; the logger added a run but
    // changed nothing about the (no-op) filing outcome.
    expect(b).toEqual(a);
  });

  it("the filed memory is unchanged whether or not logging is on", async () => {
    // With logging: capture what createMemory received.
    const withLog: Record<string, unknown>[] = [];
    const withLogStore: IntakeApplyStore = {
      createMemory: (input) => {
        withLog.push(input);
        return { memory: { id: "m" } };
      },
      updateMemory: () => null,
      archiveMemory: () => null,
      getMemory: () => null,
    };
    write("note one", 1000, "a");
    await runIntakeSweep({
      ...deps(constantClient(CREATE_JUDGMENT)),
      store: withLogStore,
      intakeLog: logStore(),
    });

    // Reset vault + inbox, run the SAME submission with NO logger.
    fs.rmSync(dataDir, { recursive: true, force: true });
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-decision-log-c-"));
    vault = createVault({ dataDir });
    const without: Record<string, unknown>[] = [];
    const withoutStore: IntakeApplyStore = {
      createMemory: (input) => {
        without.push(input);
        return { memory: { id: "m" } };
      },
      updateMemory: () => null,
      archiveMemory: () => null,
      getMemory: () => null,
    };
    write("note one", 1000, "a");
    await runIntakeSweep({ ...deps(constantClient(CREATE_JUDGMENT)), store: withoutStore });

    expect(withLog).toEqual(without); // identical store mutation input
  });
});
