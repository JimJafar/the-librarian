// Codex auto-capture adapter — pure-logic unit tests + a live-server integration
// test. Spec 2026-06-16-harness-auto-capture, Phase 2A (Codex). Mirrors the
// Claude adapter (test/claude-stop-adapter.test.ts) — Codex fires the SAME
// command-hook events (`UserPromptSubmit`/`Stop`/`SessionEnd`), so the adapter is
// the Claude adapter with `harness:"codex"`, plus a Codex-specific conv_id
// derivation (degrade gracefully; NEVER fall back to $USER/cwd) and a hard
// LIBRARIAN_AUTO_SAVE kill-switch gate inside runCapture.
//
// ASSUMED CODEX HOOK PAYLOAD SHAPE (the one genuine unknown — there is no `codex`
// CLI on this build machine to confirm a live turn). Derived from mem0's PROVEN
// install_codex_hooks.py / codex-hooks.json + its on_stop_cursor.sh /
// on_user_prompt.sh / on_session_start.sh, which read these fields off the Codex
// hook stdin JSON exactly as the Claude hook does:
//   - `session_id`      : the stable per-run/session id (may be empty)
//   - `transcript_path` : path to the conversation transcript (JSONL assumed —
//                          same `type` + `message.{role,content}` shape as Claude)
//   - `cwd`             : the working dir (NEVER used to key conv_id — spec §4.11)
//   - `agent_id`        : present on a subagent Stop (skipped, like Claude)
//   - `hook_event_name` : the event ("UserPromptSubmit"/"Stop"/"SessionEnd")
// mem0 falls back to `/tmp/..._${USER}` / `default_${USER}` when session_id is
// empty — that $USER-keying is the COLLISION BUG we explicitly avoid (concurrent
// same-machine Codex runs would share a conv_id). Our fallback is the transcript
// FILENAME, then a clean no-op. Coverage of SC1 (true e2e against a running Codex)
// is DEFERRED/unverified at the harness level (no codex CLI); it is satisfied here
// at the unit + contract level (the delta we POST is well-formed per /transcript,
// and a live LOCAL server buffers exactly the expected non-private turns).
//
// Coverage map (task SC1–6):
//   - SC1  contract: a well-formed delta is POSTed to /transcript (unit + live-server)
//   - SC2  private skip, forward-only (filterPrivateSpans + cursor skip-and-advance)
//   - SC3  idempotent (advance-on-ack) + fail-soft (never throws in the hook)
//   - SC4  default-on; suppressed under private mode + LIBRARIAN_AUTO_SAVE=false;
//          inert when the server intake gate is off
//   - SC5  stable conv_id per session id (never $USER/cwd); graceful fallback chain

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "./helpers.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = path.join(REPO_ROOT, "integrations", "codex", "scripts", "lib");

// Plain ESM `.mjs`, Node stdlib only (no build step) — import directly.
const transcript = await import(path.join(LIB, "transcript.mjs"));
const cursor = await import(path.join(LIB, "cursor.mjs"));
const post = await import(path.join(LIB, "post.mjs"));
const capture = await import(path.join(LIB, "capture.mjs"));

// ── JSONL fixture helpers (assumed Codex shape == Claude shape) ──────────────

function userLine(text: string, over: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    type: "user",
    isSidechain: false,
    timestamp: "2026-06-17T10:00:00.000Z",
    sessionId: "run-1",
    cwd: "/repo",
    message: { role: "user", content: text },
    ...over,
  })}\n`;
}

function assistantLine(text: string, over: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    type: "assistant",
    isSidechain: false,
    timestamp: "2026-06-17T10:00:01.000Z",
    sessionId: "run-1",
    cwd: "/repo",
    message: { role: "assistant", content: [{ type: "text", text }] },
    ...over,
  })}\n`;
}

// ── payload build: stamps harness:"codex" ────────────────────────────────────

describe("codex payload build", () => {
  it('builds the uniform contract delta with harness:"codex"', () => {
    const payload = transcript.buildPayload({
      convId: "run-xyz",
      seq: 3,
      turns: [{ role: "user", text: "hi", ts: "2026-06-17T10:00:00.000Z" }],
      ended: true,
    });
    expect(payload.conv_id).toBe("run-xyz");
    expect(payload.harness).toBe("codex");
    expect(payload.seq).toBe(3);
    expect(payload.turns).toEqual([{ role: "user", text: "hi", ts: "2026-06-17T10:00:00.000Z" }]);
    expect(payload.ended).toBe(true);
  });

  it("omits `ended` when not a session end", () => {
    const payload = transcript.buildPayload({ convId: "r", seq: 0, turns: [], ended: false });
    expect(payload.ended).toBeUndefined();
  });
});

// ── conv_id derivation: stable id, graceful fallback, NEVER $USER/cwd (SC5) ──

describe("conv_id derivation (SC5 — stable, never $USER/cwd)", () => {
  it("prefers the hook session_id when present", () => {
    expect(
      transcript.deriveConvId({
        session_id: "run-abc",
        transcript_path: "/x/rollout-2026.jsonl",
        cwd: "/repo",
      }),
    ).toBe("run-abc");
  });

  it("falls back to a basename+hash derived from the FULL transcript path when session_id is absent", () => {
    const id = transcript.deriveConvId({
      transcript_path: "/var/codex/sessions/rollout-2026-06-17.jsonl",
    });
    // Stable, single safe segment, carries the filename stem so it stays legible.
    expect(id).toMatch(/^rollout-2026-06-17-[0-9a-f]{8}$/);
  });

  it("derives DISTINCT conv_ids for the SAME basename in DIFFERENT directories (SC5 collision)", () => {
    // The exact SC5 collision class: two concurrent Codex conversations whose
    // transcript files share a basename in different dirs must NOT collapse onto
    // one conv_id (which would share a cursor file AND a server buffer).
    const a = transcript.deriveConvId({ transcript_path: "/home/u/projA/rollout.jsonl" });
    const b = transcript.deriveConvId({ transcript_path: "/home/u/projB/rollout.jsonl" });
    expect(a).not.toBe(b);
    // Both still carry the legible stem so they're not opaque hashes.
    expect(a).toMatch(/^rollout-[0-9a-f]{8}$/);
    expect(b).toMatch(/^rollout-[0-9a-f]{8}$/);
  });

  it("is STABLE for the same full transcript path across calls (cursor + buffer key)", () => {
    const p = "/home/u/projA/rollout.jsonl";
    expect(transcript.deriveConvId({ transcript_path: p })).toBe(
      transcript.deriveConvId({ transcript_path: p }),
    );
  });

  it("returns null when neither a session id nor a transcript path is available", () => {
    expect(transcript.deriveConvId({ cwd: "/repo" })).toBeNull();
    expect(transcript.deriveConvId({})).toBeNull();
  });

  it("NEVER falls back to cwd or $USER (two concurrent runs in one cwd must not collide)", () => {
    // No session_id, no transcript_path — even with a cwd present, conv_id is null
    // (a clean no-op upstream), never the cwd. This is the explicit mem0 bug we avoid.
    const id = transcript.deriveConvId({ cwd: "/home/alice/project" });
    expect(id).toBeNull();
    expect(id).not.toBe("/home/alice/project");
  });
});

// ── private-span filter (SC2) ────────────────────────────────────────────────

describe("codex private-span filter (SC2)", () => {
  it("skips every turn inside [private=on] … [private=off]", () => {
    const turns = [
      { role: "user", text: "public before" },
      { role: "user", text: "[librarian:private=on]" },
      { role: "assistant", text: "secret stuff" },
      { role: "user", text: "[librarian:private=off]" },
      { role: "assistant", text: "public after" },
    ];
    const { kept } = transcript.filterPrivateSpans(turns, { startPrivate: false });
    expect(kept.map((t) => t.text)).toEqual(["public before", "public after"]);
  });

  it("carries private state across runs (an unterminated span stays private)", () => {
    const run1 = transcript.filterPrivateSpans(
      [
        { role: "user", text: "[librarian:private=on]" },
        { role: "assistant", text: "hidden" },
      ],
      { startPrivate: false },
    );
    expect(run1.kept).toEqual([]);
    expect(run1.endPrivate).toBe(true);
    const run2 = transcript.filterPrivateSpans(
      [
        { role: "user", text: "[librarian:private=off]" },
        { role: "user", text: "now public" },
      ],
      { startPrivate: run1.endPrivate },
    );
    expect(run2.kept.map((t) => t.text)).toEqual(["now public"]);
  });
});

// ── parse: JSONL → turns (assumed Codex shape == Claude shape) ───────────────

describe("codex parse: JSONL → turns", () => {
  it("extracts user + assistant prose in order, dropping tool/thinking blocks", () => {
    const jsonl = userLine("how do I run tests?") + assistantLine("use pnpm test");
    const turns = transcript.entriesToTurns(transcript.parseEntries(jsonl));
    expect(turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "how do I run tests?"],
      ["assistant", "use pnpm test"],
    ]);
  });

  it("tolerates a partial trailing line (mid-write) without throwing", () => {
    const jsonl = userLine("complete") + '{"type":"assistant","message":{"rol';
    const turns = transcript.entriesToTurns(transcript.parseEntries(jsonl));
    expect(turns.map((t) => t.text)).toEqual(["complete"]);
  });
});

// ── POST-URL derivation ──────────────────────────────────────────────────────

describe("codex transcript URL derivation", () => {
  it("rewrites /mcp to /transcript on the same origin", () => {
    expect(post.deriveTranscriptUrl("https://librarian.example.com/mcp")).toBe(
      "https://librarian.example.com/transcript",
    );
  });
  it("returns null for an unusable URL (fail-soft upstream)", () => {
    expect(post.deriveTranscriptUrl("")).toBeNull();
    expect(post.deriveTranscriptUrl("not a url")).toBeNull();
  });
});

// ── cursor (SC3 advance-on-ack, SC5 per-conv isolation) ─────────────────────

describe("codex cursor (SC3 + SC5)", () => {
  let dataDir = "";
  beforeEach(() => {
    dataDir = makeTempDir();
  });
  afterEach(() => {
    if (dataDir) cleanupTempDir(dataDir);
    dataDir = "";
  });

  it("a missing cursor reads as offset 0, seq 0, not private", () => {
    expect(cursor.readCursor(dataDir, "run-1")).toEqual({ offset: 0, seq: 0, private: false });
  });

  it("two distinct conv_ids use two distinct cursor files (concurrency, SC5)", () => {
    cursor.writeCursor(dataDir, "run-A", { offset: 10, seq: 1, private: false });
    cursor.writeCursor(dataDir, "run-B", { offset: 99, seq: 5, private: true });
    expect(cursor.readCursor(dataDir, "run-A")).toEqual({ offset: 10, seq: 1, private: false });
    expect(cursor.readCursor(dataDir, "run-B")).toEqual({ offset: 99, seq: 5, private: true });
    expect(cursor.cursorPath(dataDir, "run-A")).not.toBe(cursor.cursorPath(dataDir, "run-B"));
  });

  it("sanitizes a path-traversal conv_id to a single safe segment", () => {
    const p = cursor.cursorPath(dataDir, "../../etc/passwd");
    expect(path.dirname(p)).toBe(path.join(dataDir, "cursors"));
    expect(p.includes("..")).toBe(false);
  });
});

// ── runCapture orchestration (SC2, SC3, SC4, SC5) ───────────────────────────

describe("codex runCapture orchestration", () => {
  let dataDir = "";
  let transcriptPath = "";

  beforeEach(() => {
    dataDir = makeTempDir();
    transcriptPath = path.join(dataDir, "run-1.jsonl");
  });
  afterEach(() => {
    if (dataDir) cleanupTempDir(dataDir);
    dataDir = "";
  });

  function fakePoster(ack: { ok: boolean }) {
    const calls: unknown[] = [];
    return {
      calls,
      post: async (_url: string, payload: unknown, _token: string) => {
        calls.push(payload);
        return ack;
      },
    };
  }

  const baseEnv = {
    LIBRARIAN_MCP_URL: "https://librarian.example.com/mcp",
    LIBRARIAN_AGENT_TOKEN: "agent-token",
    CODEX_PLUGIN_DATA: "",
  };

  it('ships the non-private delta with harness:"codex" and advances the cursor on a 2xx ack (SC1)', async () => {
    fs.writeFileSync(transcriptPath, userLine("how do I run tests?") + assistantLine("pnpm test"));
    const poster = fakePoster({ ok: true });
    const result = await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "run-1", hook_event_name: "UserPromptSubmit" },
      { ...baseEnv, CODEX_PLUGIN_DATA: dataDir },
      { post: poster.post },
    );
    expect(result.posted).toBe(true);
    const payload = poster.calls[0] as {
      harness: string;
      conv_id: string;
      turns: { text: string }[];
    };
    expect(payload.harness).toBe("codex");
    expect(payload.conv_id).toBe("run-1");
    expect(payload.turns.map((t) => t.text)).toEqual(["how do I run tests?", "pnpm test"]);
    const c = cursor.readCursor(dataDir, "run-1");
    expect(c.offset).toBe(fs.statSync(transcriptPath).size);
    expect(c.seq).toBe(1);
  });

  it("keys the cursor by conv_id derived from session_id, NOT cwd (SC5)", async () => {
    fs.writeFileSync(transcriptPath, userLine("q") + assistantLine("a"));
    const poster = fakePoster({ ok: true });
    await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "run-1", cwd: "/some/where" },
      { ...baseEnv, CODEX_PLUGIN_DATA: dataDir },
      { post: poster.post },
    );
    // The cursor lives under the session-id key, never the cwd.
    expect(fs.existsSync(cursor.cursorPath(dataDir, "run-1"))).toBe(true);
  });

  it("skips entirely when agent_id is present (subagent stop is a no-op)", async () => {
    fs.writeFileSync(transcriptPath, userLine("x") + assistantLine("y"));
    const poster = fakePoster({ ok: true });
    const result = await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "run-1", agent_id: "sub-7" },
      { ...baseEnv, CODEX_PLUGIN_DATA: dataDir },
      { post: poster.post },
    );
    expect(result.skipped).toBe("subagent");
    expect(poster.calls).toHaveLength(0);
  });

  it("does NOT advance the cursor on a failed POST; the next run re-ships (SC3 idempotent)", async () => {
    fs.writeFileSync(transcriptPath, userLine("q1") + assistantLine("a1"));
    const failing = fakePoster({ ok: false });
    await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "run-1" },
      { ...baseEnv, CODEX_PLUGIN_DATA: dataDir },
      { post: failing.post },
    );
    expect(cursor.readCursor(dataDir, "run-1").offset).toBe(0);
    const ok = fakePoster({ ok: true });
    const r2 = await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "run-1" },
      { ...baseEnv, CODEX_PLUGIN_DATA: dataDir },
      { post: ok.post },
    );
    expect(r2.posted).toBe(true);
    expect((ok.calls[0] as { turns: { text: string }[] }).turns.map((t) => t.text)).toEqual([
      "q1",
      "a1",
    ]);
  });

  it("forward-only private skip across runs: a private span then public never re-ships the private turns (SC2)", async () => {
    fs.writeFileSync(
      transcriptPath,
      userLine("[librarian:private=on]") + assistantLine("secret one"),
    );
    const ok = fakePoster({ ok: true });
    await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "run-1" },
      { ...baseEnv, CODEX_PLUGIN_DATA: dataDir },
      { post: ok.post },
    );
    expect(ok.calls).toHaveLength(0);
    const c1 = cursor.readCursor(dataDir, "run-1");
    expect(c1.offset).toBe(fs.statSync(transcriptPath).size);
    expect(c1.private).toBe(true);

    fs.appendFileSync(
      transcriptPath,
      userLine("[librarian:private=off]") + assistantLine("public answer"),
    );
    const r2 = await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "run-1" },
      { ...baseEnv, CODEX_PLUGIN_DATA: dataDir },
      { post: ok.post },
    );
    expect(r2.posted).toBe(true);
    const payload = ok.calls[0] as { turns: { text: string }[] };
    expect(payload.turns.map((t) => t.text)).toEqual(["public answer"]);
    expect(payload.turns.some((t) => t.text.includes("secret"))).toBe(false);
  });

  it("suppressed entirely when LIBRARIAN_AUTO_SAVE=false (the per-machine kill-switch, SC4)", async () => {
    fs.writeFileSync(transcriptPath, userLine("q") + assistantLine("a"));
    const ok = fakePoster({ ok: true });
    const result = await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "run-1" },
      { ...baseEnv, CODEX_PLUGIN_DATA: dataDir, LIBRARIAN_AUTO_SAVE: "false" },
      { post: ok.post },
    );
    expect(ok.calls).toHaveLength(0); // nothing shipped
    expect(result.skipped).toBe("auto-save-off");
    // Cursor untouched — the kill-switch ships AND buffers nothing.
    expect(cursor.readCursor(dataDir, "run-1").offset).toBe(0);
  });

  it("treats LIBRARIAN_AUTO_SAVE values other than 'false' as on (default-on, SC4)", async () => {
    fs.writeFileSync(transcriptPath, userLine("q") + assistantLine("a"));
    const ok = fakePoster({ ok: true });
    const result = await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "run-1" },
      { ...baseEnv, CODEX_PLUGIN_DATA: dataDir, LIBRARIAN_AUTO_SAVE: "true" },
      { post: ok.post },
    );
    expect(result.posted).toBe(true);
    expect(ok.calls).toHaveLength(1);
  });

  it("sets ended:true on a SessionEnd hook (explicit-end accelerator)", async () => {
    fs.writeFileSync(transcriptPath, userLine("bye") + assistantLine("cya"));
    const ok = fakePoster({ ok: true });
    await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "run-1", hook_event_name: "SessionEnd" },
      { ...baseEnv, CODEX_PLUGIN_DATA: dataDir },
      { post: ok.post },
    );
    expect((ok.calls[0] as { ended?: boolean }).ended).toBe(true);
  });

  it("does NOT set ended on a plain UserPromptSubmit/Stop (only SessionEnd accelerates)", async () => {
    fs.writeFileSync(transcriptPath, userLine("mid") + assistantLine("going"));
    const ok = fakePoster({ ok: true });
    await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "run-1", hook_event_name: "UserPromptSubmit" },
      { ...baseEnv, CODEX_PLUGIN_DATA: dataDir },
      { post: ok.post },
    );
    expect((ok.calls[0] as { ended?: boolean }).ended).toBeUndefined();
  });

  it("falls back to the transcript filename for conv_id when session_id is absent (SC5)", async () => {
    const namedPath = path.join(dataDir, "rollout-xyz.jsonl");
    fs.writeFileSync(namedPath, userLine("q") + assistantLine("a"));
    const ok = fakePoster({ ok: true });
    const result = await capture.runCapture(
      { transcript_path: namedPath }, // no session_id
      { ...baseEnv, CODEX_PLUGIN_DATA: dataDir },
      { post: ok.post },
    );
    expect(result.posted).toBe(true);
    // Fallback conv_id is the filename stem + a short hash of the FULL path (so two
    // same-basename transcripts in different dirs can't collide — SC5).
    expect((ok.calls[0] as { conv_id: string }).conv_id).toMatch(/^rollout-xyz-[0-9a-f]{8}$/);
  });

  it("clean no-op (no conv_id) when neither session_id nor transcript_path is present, NEVER cwd-keyed (SC5)", async () => {
    const ok = fakePoster({ ok: true });
    const result = await capture.runCapture(
      { cwd: "/home/alice/project" }, // only a cwd — must NOT become the conv_id
      { ...baseEnv, CODEX_PLUGIN_DATA: dataDir },
      { post: ok.post },
    );
    expect(ok.calls).toHaveLength(0);
    expect(result.skipped).toBe("no-conv-id");
  });

  it("fail-soft: an unreachable endpoint resolves (no throw), cursor not advanced (SC3)", async () => {
    fs.writeFileSync(transcriptPath, userLine("q") + assistantLine("a"));
    const throwingPoster = {
      post: async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:1");
      },
    };
    let result: { posted: boolean } | undefined;
    await expect(
      (async () => {
        result = await capture.runCapture(
          { transcript_path: transcriptPath, session_id: "run-1" },
          { ...baseEnv, CODEX_PLUGIN_DATA: dataDir },
          throwingPoster,
        );
      })(),
    ).resolves.not.toThrow();
    expect(result?.posted).toBe(false);
    expect(cursor.readCursor(dataDir, "run-1").offset).toBe(0);
  });

  it("fail-soft: missing LIBRARIAN_MCP_URL / token is a clean no-op (SC3)", async () => {
    fs.writeFileSync(transcriptPath, userLine("q") + assistantLine("a"));
    const ok = fakePoster({ ok: true });
    const result = await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "run-1" },
      { CODEX_PLUGIN_DATA: dataDir }, // no URL/token
      { post: ok.post },
    );
    expect(ok.calls).toHaveLength(0);
    expect(result.skipped).toBe("not-configured");
  });
});

// ── live-server end-to-end (SC1, at contract level — true Codex e2e DEFERRED) ─
// There is no `codex` CLI on this build machine to drive a real turn, so SC1's
// FULL acceptance (a live Codex session) is DEFERRED/unverified. This proves the
// next-best thing: the exact delta the adapter ships validates against the REAL
// /transcript intake and buffers exactly the non-private turns.

describe("end-to-end against a live server (SC1 — contract level; true Codex e2e deferred)", () => {
  let dataDir = "";
  let serverDataDir = "";
  let server: Awaited<ReturnType<typeof startHttpServer>> | null = null;
  let transcriptPath = "";

  beforeEach(() => {
    dataDir = makeTempDir();
    serverDataDir = makeTempDir();
    transcriptPath = path.join(dataDir, "run-e2e.jsonl");
  });
  afterEach(async () => {
    if (server) await server.stop();
    server = null;
    if (dataDir) cleanupTempDir(dataDir);
    if (serverDataDir) cleanupTempDir(serverDataDir);
    dataDir = "";
    serverDataDir = "";
  });

  it("buffers the non-private turns server-side; private turns never land", async () => {
    server = await startHttpServer({ dataDir: serverDataDir, intake: "on" });

    fs.writeFileSync(
      transcriptPath,
      userLine("how do I run the tests in this repo?") +
        assistantLine("run pnpm test from the repo root") +
        userLine("[librarian:private=on]") +
        assistantLine("my api token is hunter2") +
        userLine("[librarian:private=off]") +
        userLine("thanks, what about typecheck?") +
        assistantLine("pnpm typecheck runs tsc across every workspace"),
    );

    const result = await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "run-e2e", hook_event_name: "SessionEnd" },
      {
        LIBRARIAN_MCP_URL: `${server.url}/mcp`,
        LIBRARIAN_AGENT_TOKEN: server.agentToken,
        CODEX_PLUGIN_DATA: dataDir,
      },
      { post: post.postDelta },
    );

    expect(result.posted).toBe(true);
    expect(result.ack?.ok).toBe(true);
    expect(result.ack?.buffered).toBe(4);

    // SessionEnd drops a sibling `<conv_id>.ended` accelerator marker alongside
    // the buffer; assert against the markdown buffer specifically (not a raw count).
    const bufferDir = path.join(serverDataDir, "transcripts");
    const bufferFiles = fs.readdirSync(bufferDir).filter((f) => f.endsWith(".md"));
    expect(bufferFiles).toHaveLength(1);
    const body = fs.readFileSync(path.join(bufferDir, bufferFiles[0]), "utf8");
    expect(body).toContain("how do I run the tests in this repo?");
    expect(body).toContain("pnpm typecheck runs tsc");
    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("[librarian:private=on]");
  });

  it("server refuses + buffers nothing when the intake gate is OFF (SC4 inert)", async () => {
    server = await startHttpServer({ dataDir: serverDataDir, intake: "off" });
    fs.writeFileSync(transcriptPath, userLine("q") + assistantLine("a"));
    const result = await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "run-e2e" },
      {
        LIBRARIAN_MCP_URL: `${server.url}/mcp`,
        LIBRARIAN_AGENT_TOKEN: server.agentToken,
        CODEX_PLUGIN_DATA: dataDir,
      },
      { post: post.postDelta },
    );
    // The server returns 200 (so the adapter's ack is ok → it advances), but the
    // gate-off path accepts and BUFFERS NOTHING — no raw text at rest for a dead
    // pipeline. `buffered` is absent (the server returns {accepted:false,disabled}).
    expect(result.ack?.ok).toBe(true);
    expect(result.ack?.buffered).toBeUndefined();
    const bufferDir = path.join(serverDataDir, "transcripts");
    expect(fs.existsSync(bufferDir) ? fs.readdirSync(bufferDir) : []).toEqual([]);
  });
});
