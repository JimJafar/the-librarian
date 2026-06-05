// T2.3 — Snapshot tests for the hook-injection helper.
//
// The exact rendered shape is contractual — every harness integration
// reads it via the same helper, and the LLM consumes a stable byte
// sequence each turn. Locking it down here. (D16 dropped the `domain`
// line; sessions-retirement dropped the always-`none` `session_id` line —
// the block is now just `conv_id` + `off_record`.)

import { renderConvStateBlock } from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("renderConvStateBlock (T2.3)", () => {
  it("returns empty string when there is no state", () => {
    expect(renderConvStateBlock(null)).toBe("");
  });

  it("renders the canonical block (conv_id + off_record only)", () => {
    const out = renderConvStateBlock({
      conv_id: "claude:abc-123",
      harness: "claude-code",
      session_id: "ses_xyz",
      off_record: false,
      created_at: "2026-05-27T00:00:00.000Z",
      updated_at: "2026-05-27T00:00:00.000Z",
    });
    expect(out).toBe(
      [
        "<conversation-state>",
        "  conv_id: claude:abc-123",
        "  off_record: false",
        "</conversation-state>",
      ].join("\n"),
    );
  });

  it("never renders the retired domain/session_id lines", () => {
    const out = renderConvStateBlock({
      conv_id: "claude:abc-123",
      harness: "claude-code",
      session_id: "ses_xyz",
      off_record: false,
      created_at: "2026-05-27T00:00:00.000Z",
      updated_at: "2026-05-27T00:00:00.000Z",
    });
    expect(out).not.toContain("session_id");
    expect(out).not.toContain("domain");
  });

  it("renders off_record true when the flag is on", () => {
    const out = renderConvStateBlock({
      conv_id: "claude:abc-123",
      harness: "claude-code",
      session_id: null,
      off_record: true,
      created_at: "2026-05-27T00:00:00.000Z",
      updated_at: "2026-05-27T00:00:00.000Z",
    });
    expect(out).toContain("  off_record: true");
  });

  it("produces deterministic bytes across calls — every harness sees the same shape", () => {
    const state = {
      conv_id: "hermes:thread-7",
      harness: "hermes",
      session_id: "ses_qa",
      off_record: false,
      created_at: "2026-05-27T00:00:00.000Z",
      updated_at: "2026-05-27T00:00:00.000Z",
    };
    expect(renderConvStateBlock(state)).toBe(renderConvStateBlock({ ...state }));
  });
});
