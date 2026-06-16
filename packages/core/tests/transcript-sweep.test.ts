// Transcript settle-sweep + lifecycle (spec 2026-06-16-harness-auto-capture, T2).
// The EXTRACTION clock: a background tick scans <dataDir>/transcripts/ for
// SETTLED buffers (idle / explicit-end / size-cap), atomically CLAIMS each
// (→ .processing), makes ONE extractor pass (mocked LLM), submits each fact to
// the EXISTING inbox via submitToInbox, then DELETES the claimed buffer. An
// orphaned .processing is reaped. The whole tick SELF-GATES on
// isIntakeEnabled(store) — the same gate T1's endpoint and the intake tick read.
//
// Network-free: the extractor LLM client is injected (buildClient), mirroring
// runIntakeTick's injectable builder; the inbox submission is observed by
// spying the store's submitToInbox.
//
//   - SC1 (server half): a settled, substantive buffer → claim → extract → N
//     facts reach the inbox; the buffer is then deleted.
//   - SC3 (settle-by-idle): an idle buffer is extracted with NO end event; a
//     fresh buffer is left alone.
//   - SC6 (hygiene): atomic claim to .processing; delete-after; reaper recovers
//     an orphaned .processing; nothing escapes transcripts/.
//   - SC7 (gate coherence): intake disabled → nothing extracted, buffers
//     untouched.
//   - size-cap settle path; trivial buffer → no-op (no facts) but still deleted.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  INTAKE_ENABLED_KEY,
  type LibrarianStore,
  type LlmClient,
  addProvider,
  createLibrarianStore,
  endedMarkerPath,
  resolveSecretKey,
  runTranscriptSweepTick,
  transcriptBufferPath,
  transcriptProcessingPath,
  transcriptsDir,
  writeConsumerConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 32-byte master key assembled at runtime (AGENTS.md GitGuardian note).
const KEY = resolveSecretKey("0123456789abcdef".repeat(4));

let store: LibrarianStore | null = null;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-tsweep-"));
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
  dataDir = "";
});

/** Enable intake + point its consumer at a tokened provider (the sweep reuses it). */
function enableCapture(): void {
  store!.setSetting(INTAKE_ENABLED_KEY, "true");
  const provider = addProvider(store!, {
    name: "default",
    endpoint: "https://e/v1",
    token: "dummy-decrypted-token",
  });
  writeConsumerConfig(store!, "intake", { providerId: provider.id, model: "gpt-x" });
}

/** A fake extractor LLM returning a fixed candidate-facts payload. */
function factsClient(facts: string[]): LlmClient {
  return {
    complete: async () => ({ content: JSON.stringify({ facts }), model: "m", usage: null }),
  };
}

/** Write a buffer file for a conv_id with the given content + mtime age (ms ago). */
function writeBuffer(convId: string, content: string, ageMs = 0): string {
  const p = transcriptBufferPath(dataDir, convId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(p, when, when);
  }
  return p;
}

const IDLE_MS = 30 * 60_000;

describe("runTranscriptSweepTick — settle + extract → inbox (SC1)", () => {
  it("claims a settled substantive buffer, extracts N facts to the inbox, then deletes it", async () => {
    enableCapture();
    const bufferPath = writeBuffer(
      "conv-1",
      "### user\n\nWe decided to standardise on pnpm.\n\n### assistant\n\nNoted.\n",
      IDLE_MS + 60_000, // idle → settled
    );
    const submitSpy = vi.spyOn(store!, "submitToInbox");

    const summary = await runTranscriptSweepTick({
      store: store!,
      buildClient: () =>
        factsClient([
          "The repo standardises on pnpm.",
          "Test runner is invoked from the repo root.",
        ]),
    });

    // Each candidate fact was submitted INDIVIDUALLY to the existing inbox.
    expect(submitSpy).toHaveBeenCalledTimes(2);
    expect(submitSpy.mock.calls.map((c) => c[0])).toEqual([
      "The repo standardises on pnpm.",
      "Test runner is invoked from the repo root.",
    ]);
    expect(summary).toMatchObject({ extracted: 1, facts: 2 });

    // The buffer (and its claim) are gone — zero trace; only inbox facts persist.
    expect(fs.existsSync(bufferPath)).toBe(false);
    expect(fs.existsSync(transcriptProcessingPath(dataDir, "conv-1"))).toBe(false);
  });

  it("tags each submission with auto-capture hints (source + harness)", async () => {
    enableCapture();
    writeBuffer("conv-h", "### user\n\nsubstantive content here\n", IDLE_MS + 1);
    const submitSpy = vi.spyOn(store!, "submitToInbox");

    await runTranscriptSweepTick({
      store: store!,
      buildClient: () => factsClient(["a durable fact"]),
    });

    expect(submitSpy).toHaveBeenCalledTimes(1);
    const hints = submitSpy.mock.calls[0]?.[1];
    expect(hints?.tags).toEqual(expect.arrayContaining(["auto_capture"]));
  });
});

describe("runTranscriptSweepTick — settle by idle, no end event (SC3)", () => {
  it("extracts an idle buffer and leaves a fresh one alone", async () => {
    enableCapture();
    const idle = writeBuffer("conv-idle", "### user\n\nold but substantive\n", IDLE_MS + 60_000);
    const fresh = writeBuffer("conv-fresh", "### user\n\njust happened\n", 1_000); // 1s old

    const summary = await runTranscriptSweepTick({
      store: store!,
      buildClient: () => factsClient(["a fact from the idle conversation"]),
    });

    // The idle buffer settled + was consumed; the fresh one is untouched.
    expect(fs.existsSync(idle)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(summary.extracted).toBe(1);
    expect(summary.skipped).toBe(1);
  });

  it("respects a custom idle window", async () => {
    enableCapture();
    const buf = writeBuffer("conv-x", "### user\n\ncontent\n", 5_000); // 5s old
    // With a 1s idle window, 5s-old IS settled.
    await runTranscriptSweepTick({
      store: store!,
      idleMs: 1_000,
      buildClient: () => factsClient(["fact"]),
    });
    expect(fs.existsSync(buf)).toBe(false);
  });
});

describe("runTranscriptSweepTick — explicit-end accelerator", () => {
  it("extracts a FRESH buffer immediately when an end marker is present", async () => {
    enableCapture();
    // Fresh (not idle), but the harness signalled ended:true (T1 wrote the marker).
    const buf = writeBuffer("conv-end", "### user\n\nwrap-up content\n", 1_000);
    fs.writeFileSync(endedMarkerPath(dataDir, "conv-end"), "", "utf8");

    const summary = await runTranscriptSweepTick({
      store: store!,
      buildClient: () => factsClient(["a fact"]),
    });

    expect(summary.extracted).toBe(1);
    expect(fs.existsSync(buf)).toBe(false);
    // The marker is cleaned up with the buffer.
    expect(fs.existsSync(endedMarkerPath(dataDir, "conv-end"))).toBe(false);
  });
});

describe("runTranscriptSweepTick — size-cap settle path", () => {
  it("extracts an over-size buffer even when fresh", async () => {
    enableCapture();
    const big = "x".repeat(2_000);
    const buf = writeBuffer("conv-big", `### user\n\n${big}\n`, 1_000); // fresh
    const summary = await runTranscriptSweepTick({
      store: store!,
      maxBytes: 1_000, // tiny cap → settled by size
      buildClient: () => factsClient(["fact from the runaway buffer"]),
    });
    expect(summary.extracted).toBe(1);
    expect(fs.existsSync(buf)).toBe(false);
  });
});

describe("runTranscriptSweepTick — trivial buffer", () => {
  it("a settled buffer that yields no facts is still deleted (no inbox writes)", async () => {
    enableCapture();
    const buf = writeBuffer("conv-trivial", "### user\n\nhi\n", IDLE_MS + 1);
    const submitSpy = vi.spyOn(store!, "submitToInbox");

    const summary = await runTranscriptSweepTick({
      store: store!,
      buildClient: () => factsClient([]), // model finds nothing durable
    });

    expect(submitSpy).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ extracted: 1, facts: 0 });
    // Still deleted — zero trace.
    expect(fs.existsSync(buf)).toBe(false);
  });
});

describe("runTranscriptSweepTick — hygiene + reaper (SC6)", () => {
  it("reaps an orphaned .processing (crash mid-extract) and re-extracts it", async () => {
    enableCapture();
    // Simulate a crash: a .processing claim left behind, older than the reaper TTL.
    const proc = transcriptProcessingPath(dataDir, "conv-orphan");
    fs.mkdirSync(path.dirname(proc), { recursive: true });
    fs.writeFileSync(proc, "### user\n\nstranded but substantive\n", "utf8");
    const old = new Date(Date.now() - 60 * 60_000); // 1h old
    fs.utimesSync(proc, old, old);
    const submitSpy = vi.spyOn(store!, "submitToInbox");

    const summary = await runTranscriptSweepTick({
      store: store!,
      reaperTtlMs: 10 * 60_000, // 10 min TTL → the 1h-old claim is reaped
      buildClient: () => factsClient(["the rescued fact"]),
    });

    expect(submitSpy).toHaveBeenCalledWith("the rescued fact", expect.anything());
    expect(summary.reaped).toBeGreaterThanOrEqual(1);
    // The orphan is consumed + deleted — nothing stranded.
    expect(fs.existsSync(proc)).toBe(false);
  });

  it("leaves a RECENT .processing alone (an in-flight claim is not stolen)", async () => {
    enableCapture();
    const proc = transcriptProcessingPath(dataDir, "conv-inflight");
    fs.mkdirSync(path.dirname(proc), { recursive: true });
    fs.writeFileSync(proc, "### user\n\nbeing processed right now\n", "utf8"); // fresh mtime

    const summary = await runTranscriptSweepTick({
      store: store!,
      reaperTtlMs: 10 * 60_000,
      buildClient: () => factsClient(["should not be touched"]),
    });

    // A fresh claim is younger than the TTL → not reaped, not consumed.
    expect(fs.existsSync(proc)).toBe(true);
    expect(summary.reaped).toBe(0);
  });

  it("never writes outside transcripts/ (claim + delete stay contained)", async () => {
    enableCapture();
    writeBuffer("conv-contained", "### user\n\ncontent\n", IDLE_MS + 1);
    // Snapshot the data-dir's siblings before the sweep so we can prove nothing
    // escaped to the parent.
    const parent = path.resolve(dataDir, "..");
    const siblingsBefore = new Set(fs.readdirSync(parent));

    await runTranscriptSweepTick({
      store: store!,
      buildClient: () => factsClient(["fact"]),
    });

    // The transcripts/ dir survives; no NEW artifact appeared beside the data dir.
    expect(fs.existsSync(transcriptsDir(dataDir))).toBe(true);
    const siblingsAfter = fs.readdirSync(parent);
    for (const entry of siblingsAfter) {
      expect(siblingsBefore.has(entry)).toBe(true);
    }
  });
});

describe("runTranscriptSweepTick — gate coherence (SC7)", () => {
  it("extracts nothing and leaves buffers untouched when intake is disabled", async () => {
    // Intake gate OFF (do NOT call enableCapture).
    store!.setSetting(INTAKE_ENABLED_KEY, "false");
    const buf = writeBuffer("conv-gated", "### user\n\nwould-be content\n", IDLE_MS + 60_000);
    const submitSpy = vi.spyOn(store!, "submitToInbox");

    const summary = await runTranscriptSweepTick({
      store: store!,
      buildClient: () => factsClient(["nope"]),
    });

    expect(submitSpy).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ extracted: 0, facts: 0 });
    // The buffer is left exactly where it was — no claim, no delete.
    expect(fs.existsSync(buf)).toBe(true);
    expect(fs.existsSync(transcriptProcessingPath(dataDir, "conv-gated"))).toBe(false);
  });
});

describe("runTranscriptSweepTick — fail-soft", () => {
  it("a missing transcripts/ dir is a clean no-op (never throws)", async () => {
    enableCapture();
    // No buffers written at all.
    await expect(runTranscriptSweepTick({ store: store! })).resolves.toMatchObject({
      extracted: 0,
    });
  });

  it("an extractor failure on one buffer never aborts the rest of the sweep", async () => {
    enableCapture();
    writeBuffer("conv-a-fails", "### user\n\nfirst\n", IDLE_MS + 1);
    writeBuffer("conv-b-ok", "### user\n\nsecond\n", IDLE_MS + 1);
    let call = 0;
    const flaky: LlmClient = {
      complete: async () => {
        call += 1;
        if (call === 1) throw new Error("boom");
        return { content: JSON.stringify({ facts: ["recovered fact"] }), model: "m", usage: null };
      },
    };

    const summary = await runTranscriptSweepTick({ store: store!, buildClient: () => flaky });

    // One buffer's extractor threw (0 facts, fail-soft), the other still ran.
    expect(summary.extracted).toBe(2);
    expect(summary.facts).toBe(1);
  });
});
