// Intake tick (plan 036 Phase 4 / spec 035 §F5) — the config-driven
// entrypoint the scheduler calls. Verifies gating (incomplete config / no
// token / unsupported backend) and that an operational config builds the client
// + runs one inbox sweep. Network-free via an injected client builder.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type LlmClient,
  type LlmCompletionRequest,
  addProvider,
  createLibrarianStore,
  resolveSecretKey,
  runIntakeTick,
  setAddendumStatus,
  setIntakeEnabled,
  setJobAddendum,
  writeConsumerConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Build the 32-byte master key at runtime from a short, sub-threshold literal so
// no 64-hex string (which GitGuardian reads as a high-entropy secret) sits in the
// committed source. Varied bytes — resolveSecretKey rejects a constant-byte key.
const KEY = resolveSecretKey("0123456789abcdef".repeat(4));

let store: LibrarianStore | null = null;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-consol-tick-"));
  store = createLibrarianStore({ dataDir, backend: "markdown", secretKey: KEY });
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

function createJudgmentClient(): LlmClient {
  return {
    complete: async () => ({
      content: JSON.stringify({
        action: "create",
        title: "Anna",
        body: "Anna lives in Berlin.",
        tags: [],
        rationale: "novel",
        confidence: 0.97,
      }),
      model: "m",
      usage: null,
    }),
  };
}

// Point the intake consumer at a provider with a token (042 2A) AND enable intake
// (the tick self-gates on curator.intake.enabled — D-1 — so the operational paths
// must turn it on, mirroring how the grooming tests call writeCuratorConfig).
function configureLlm() {
  setIntakeEnabled(store!, true);
  const provider = addProvider(store!, {
    name: "default",
    endpoint: "https://e/v1",
    token: "dummy-decrypted-token",
  });
  writeConsumerConfig(store!, "intake", { providerId: provider.id, model: "gpt-x" });
}

describe("runIntakeTick — gating", () => {
  it("does nothing when intake is disabled (the default)", async () => {
    // Self-gate first (spec 045 D-1): a disabled intake never sweeps, even with a
    // complete LLM config — exactly mirroring grooming's curator.enabled gate.
    const provider = addProvider(store!, {
      name: "default",
      endpoint: "https://e/v1",
      token: "dummy-decrypted-token",
    });
    writeConsumerConfig(store!, "intake", { providerId: provider.id, model: "gpt-x" });
    const result = await runIntakeTick({ store: store! });
    expect(result).toEqual({ ran: false, reason: "disabled" });
  });

  it("does not run when the LLM connection is incomplete (no model/token)", async () => {
    setIntakeEnabled(store!, true);
    const result = await runIntakeTick({ store: store! });
    expect(result).toEqual({ ran: false, reason: "incomplete_config" });
  });

  it("does not run when the configured token can't be decrypted", async () => {
    configureLlm();
    store!.close();
    // Reopen WITHOUT the master key: config reads complete (token presence is
    // metadata), but the token can't be decrypted → not runnable.
    store = createLibrarianStore({ dataDir, backend: "markdown" });
    const result = await runIntakeTick({
      store: store!,
      buildClient: () => createJudgmentClient(),
    });
    expect(result).toEqual({ ran: false, reason: "no_token" });
  });
});

describe("runIntakeTick — operational", () => {
  it("builds the client from config and runs one inbox sweep", async () => {
    configureLlm();
    store!.submitToInbox("Anna moved to Berlin.");
    const buildClient = vi.fn(() => createJudgmentClient());

    const result = await runIntakeTick({ store: store!, buildClient });

    expect(result).toMatchObject({ ran: true, summary: { consolidated: 1 } });
    expect(buildClient).toHaveBeenCalledTimes(1);
    // The decrypted token + the configured connection flow into the builder.
    expect(buildClient).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "https://e/v1", model: "gpt-x" }),
      "dummy-decrypted-token",
    );
    // It filed the submission as a recallable memory.
    expect(
      store!.searchMemories({ query: "Anna", status: "active" }).map((m) => m.title),
    ).toContain("Anna");
  });

  it("feeds the intake addendum from the committed vault file into the prompt (spec 044 D-2)", async () => {
    configureLlm();
    store!.submitToInbox("Anna moved to Berlin.");
    // The intake addendum lives in the committed vault file (spec 044 D-1); it is
    // read ONCE per sweep at the tick and threaded down into each item's judge call.
    setJobAddendum(store!, "intake", "MARKER-ADDENDUM prefer the lessons folder");

    let capturedPrompt = "";
    const capturingClient: LlmClient = {
      complete: async (request: LlmCompletionRequest) => {
        capturedPrompt = request.messages.map((m) => m.content).join("\n");
        return {
          content: JSON.stringify({
            action: "create",
            title: "Anna",
            body: "Anna lives in Berlin.",
            tags: [],
            rationale: "novel",
            confidence: 0.97,
          }),
          model: "m",
          usage: null,
        };
      },
    };

    const result = await runIntakeTick({ store: store!, buildClient: () => capturingClient });

    expect(result).toMatchObject({ ran: true });
    // The file's content reached the intake prompt (the OPERATOR GUIDANCE block).
    expect(capturedPrompt).toContain("MARKER-ADDENDUM prefer the lessons folder");
  });

  it("force-proposes (no auto-apply) while the intake addendum is under_evaluation (spec 044 D-3)", async () => {
    configureLlm();
    setJobAddendum(store!, "intake", "freshly changed guidance");
    setAddendumStatus(store!, "intake", "under_evaluation");
    const evalVersion = store!.readAddendum("intake").version;
    store!.submitToInbox("Anna moved to Berlin.");

    // The judge would auto-apply a high-confidence create; under evaluation it must
    // land as a PROPOSED memory, NOT an active one — proven end-to-end through the tick.
    const result = await runIntakeTick({
      store: store!,
      buildClient: () => createJudgmentClient(),
    });
    expect(result).toMatchObject({ ran: true, summary: { consolidated: 1 } });

    // Nothing active was created…
    expect(store!.searchMemories({ query: "Anna", status: "active" })).toEqual([]);
    // …it's a proposal, tagged with the eval version.
    const proposed = store!.searchMemories({ query: "Anna", status: "proposed" });
    expect(proposed.length).toBe(1);
    expect(proposed[0]?.curator_note?.addendum_version).toBe(evalVersion);
  });

  it("omits the operator-guidance block when the intake addendum file is absent (today's behaviour)", async () => {
    configureLlm();
    store!.submitToInbox("Anna moved to Berlin.");
    // No intake addendum file written → fail-soft empty → byte-identical prompt to
    // before D2 (no OPERATOR GUIDANCE block).

    let capturedPrompt = "";
    const capturingClient: LlmClient = {
      complete: async (request: LlmCompletionRequest) => {
        capturedPrompt = request.messages.map((m) => m.content).join("\n");
        return {
          content: JSON.stringify({
            action: "create",
            title: "Anna",
            body: "Anna lives in Berlin.",
            tags: [],
            rationale: "novel",
            confidence: 0.97,
          }),
          model: "m",
          usage: null,
        };
      },
    };

    const result = await runIntakeTick({ store: store!, buildClient: () => capturingClient });

    expect(result).toMatchObject({ ran: true });
    expect(capturedPrompt).not.toContain("OPERATOR GUIDANCE");
  });
});
