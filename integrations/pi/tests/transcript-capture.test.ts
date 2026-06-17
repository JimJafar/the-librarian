// Pure auto-capture transforms (Phase 2B / T-Pi). No IO, no network: the
// AgentMessage[] the `agent_end` hook hands over → contract turns → forward-only
// private filter → the uniform /transcript delta. Mirrors the Claude/Hermes
// adapters' GUARANTEES in Pi's native TS.

import { describe, expect, it } from "vitest";
import {
  HARNESS,
  buildPayload,
  filterPrivateSpans,
  messagesToTurns,
} from "../extensions/librarian/transcript-capture.js";

// A minimal AgentMessage-shaped object (the §11.2-expected in-payload turn). The
// real type is `@earendil-works/pi-ai` Message; we build the prose-bearing subset.
function userMsg(text: string, ts?: number) {
  return { role: "user", content: text, timestamp: ts ?? 1_700_000_000_000 };
}
function userBlocks(blocks: unknown[], ts?: number) {
  return { role: "user", content: blocks, timestamp: ts ?? 1_700_000_000_000 };
}
function assistantMsg(blocks: unknown[], ts?: number) {
  return { role: "assistant", content: blocks, timestamp: ts ?? 1_700_000_000_000 };
}

describe("messagesToTurns (AgentMessage[] → contract turns)", () => {
  it("maps a user string + assistant text blocks to ordered prose turns", () => {
    const turns = messagesToTurns([
      userMsg("what is the deploy command?"),
      assistantMsg([{ type: "text", text: "run make deploy" }]),
    ]);
    expect(turns).toEqual([
      { role: "user", text: "what is the deploy command?", ts: "2023-11-14T22:13:20.000Z" },
      { role: "assistant", text: "run make deploy", ts: "2023-11-14T22:13:20.000Z" },
    ]);
  });

  it("converts the numeric epoch-ms timestamp to an ISO-8601 string", () => {
    const [turn] = messagesToTurns([userMsg("hi", 1_718_000_000_000)]);
    expect(turn?.ts).toBe(new Date(1_718_000_000_000).toISOString());
  });

  it("omits ts when the message has no usable timestamp", () => {
    const turns = messagesToTurns([{ role: "user", content: "hi" }]);
    expect(turns).toEqual([{ role: "user", text: "hi" }]);
  });

  it("drops assistant thinking and toolCall blocks, keeping only text prose", () => {
    const turns = messagesToTurns([
      assistantMsg([
        { type: "thinking", thinking: "secret reasoning" },
        { type: "text", text: "the answer" },
        { type: "toolCall", id: "1", name: "bash", arguments: {} },
      ]),
    ]);
    expect(turns).toEqual([
      { role: "assistant", text: "the answer", ts: "2023-11-14T22:13:20.000Z" },
    ]);
  });

  it("joins multiple assistant text blocks with newlines", () => {
    const turns = messagesToTurns([
      assistantMsg([
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ]),
    ]);
    expect(turns[0]?.text).toBe("line one\nline two");
  });

  it("extracts user text from a content-block array (text blocks only)", () => {
    const turns = messagesToTurns([
      userBlocks([
        { type: "text", text: "describe this" },
        { type: "image", data: "...", mimeType: "image/png" },
      ]),
    ]);
    expect(turns).toEqual([
      { role: "user", text: "describe this", ts: "2023-11-14T22:13:20.000Z" },
    ]);
  });

  it("skips toolResult messages (machine plumbing, never prose)", () => {
    const turns = messagesToTurns([
      { role: "toolResult", toolCallId: "1", toolName: "bash", content: [], isError: false },
      userMsg("real prompt"),
    ]);
    expect(turns.map((t) => t.role)).toEqual(["user"]);
  });

  it("skips a custom AgentMessage with no user/assistant role", () => {
    const turns = messagesToTurns([
      { customType: "my-ext", content: "ui note" },
      assistantMsg([{ type: "text", text: "kept" }]),
    ]);
    expect(turns.map((t) => t.text)).toEqual(["kept"]);
  });

  it("drops a message whose text is empty after extraction (a tool-only step)", () => {
    const turns = messagesToTurns([
      assistantMsg([{ type: "toolCall", id: "1", name: "bash", arguments: {} }]),
      userMsg("   "),
    ]);
    expect(turns).toEqual([]);
  });

  it("is fail-soft on garbage input (non-array, nulls, wrong shapes) → []", () => {
    expect(messagesToTurns(undefined as unknown as unknown[])).toEqual([]);
    expect(messagesToTurns(null as unknown as unknown[])).toEqual([]);
    expect(messagesToTurns("nope" as unknown as unknown[])).toEqual([]);
    expect(messagesToTurns([null, 42, { role: "user" }, { content: "x" }] as unknown[])).toEqual(
      [],
    );
  });
});

describe("filterPrivateSpans (forward-only private skip, carry-forward)", () => {
  const u = (text: string) => ({ role: "user" as const, text });
  const a = (text: string) => ({ role: "assistant" as const, text });

  it("keeps every turn when no marker and no open span", () => {
    const { kept, endPrivate } = filterPrivateSpans([u("q1"), a("a1")], { startPrivate: false });
    expect(kept).toEqual([u("q1"), a("a1")]);
    expect(endPrivate).toBe(false);
  });

  it("skips the [private=on] turn and leaves the span open", () => {
    const { kept, endPrivate } = filterPrivateSpans([u("[librarian:private=on] secret")], {
      startPrivate: false,
    });
    expect(kept).toEqual([]);
    expect(endPrivate).toBe(true);
  });

  it("carries an open span forward: a markerless turn while private is skipped", () => {
    const { kept, endPrivate } = filterPrivateSpans([u("still secret")], { startPrivate: true });
    expect(kept).toEqual([]);
    expect(endPrivate).toBe(true);
  });

  it("closes the span on [private=off] (the boundary turn itself is skipped)", () => {
    const { kept, endPrivate } = filterPrivateSpans([u("[librarian:private=off] back"), u("hi")], {
      startPrivate: true,
    });
    expect(kept).toEqual([u("hi")]);
    expect(endPrivate).toBe(false);
  });

  it("never retroactively ships private turns: on→…→off→public keeps only public", () => {
    const { kept } = filterPrivateSpans(
      [
        u("[librarian:private=on] sensitive"),
        a("noted"),
        u("[librarian:private=off] done"),
        u("a normal question"),
        a("a normal answer"),
      ],
      { startPrivate: false },
    );
    expect(kept).toEqual([u("a normal question"), a("a normal answer")]);
  });

  it("honors the LAST marker in a turn so a re-open stays private", () => {
    const { endPrivate } = filterPrivateSpans(
      [u("[librarian:private=off] x [librarian:private=on] y")],
      { startPrivate: false },
    );
    expect(endPrivate).toBe(true);
  });
});

describe("buildPayload (the uniform /transcript contract body)", () => {
  it("builds {conv_id, harness:'pi', seq, turns} and omits ended when false", () => {
    const payload = buildPayload({
      convId: "sess-1",
      seq: 3,
      turns: [{ role: "user", text: "hi" }],
    });
    expect(payload).toEqual({
      conv_id: "sess-1",
      harness: "pi",
      seq: 3,
      turns: [{ role: "user", text: "hi" }],
    });
    expect("ended" in payload).toBe(false);
  });

  it("includes ended:true only when ended", () => {
    const payload = buildPayload({ convId: "s", seq: 1, turns: [], ended: true });
    expect(payload.ended).toBe(true);
  });

  it("pins the harness name to 'pi'", () => {
    expect(HARNESS).toBe("pi");
    expect(buildPayload({ convId: "s", seq: 1, turns: [] }).harness).toBe("pi");
  });
});
