// Handoff <-> markdown-document mapping tests (plan 036 Phase 2 / F9). A
// handoff is stored as a markdown file: frontmatter metadata + the 5-heading
// narrative body (the document_md, preserved verbatim — the cross-repo
// 5-heading contract lives in that body). Lossless, deterministic round-trip
// across all field types incl. the nested claimed_by object and nullables.

import {
  type HandoffDetail,
  parseHandoffDocument,
  serializeHandoffDocument,
} from "@librarian/core";
import { describe, expect, it } from "vitest";

const handoff: HandoffDetail = {
  handoff_id: "hdo_abc",
  title: "Continue the migration",
  document_md: [
    "## Start & intent",
    "do the thing.",
    "",
    "## Journey",
    "tried X then Y. See [[the-librarian]].",
    "",
    "## Current state",
    "green tests.",
    "",
    "## What's left",
    "ship it.",
    "",
    "## Open questions",
    "none.",
  ].join("\n"),
  project_key: "the-librarian",
  source_ref: null,
  cwd: "/repo",
  created_by_agent_id: "agent-a",
  created_in_harness: "claude-code",
  tags: ["migration"],
  created_at: "2026-06-01T09:00:00.000Z",
  claimed_at: null,
  claimed_by: null,
};

describe("handoff <-> document mapping", () => {
  it("round-trips by value: parse(serialize(h)) deep-equals h", () => {
    expect(parseHandoffDocument(serializeHandoffDocument(handoff))).toEqual(handoff);
  });

  it("round-trips byte-for-byte: serialize(parse(x)) === x", () => {
    const x = serializeHandoffDocument(handoff);
    expect(serializeHandoffDocument(parseHandoffDocument(x))).toBe(x);
  });

  it("preserves the 5-heading document body verbatim (incl. wikilinks)", () => {
    const parsed = parseHandoffDocument(serializeHandoffDocument(handoff));
    expect(parsed.document_md).toBe(handoff.document_md);
    expect(parsed.document_md).toContain("[[the-librarian]]");
  });

  it("round-trips a claimed handoff with its nested claimed_by object", () => {
    const claimed: HandoffDetail = {
      ...handoff,
      claimed_at: "2026-06-02T10:00:00.000Z",
      claimed_by: { agent_id: "agent-b", harness: "codex", source_ref: null, cwd: null },
    };
    const parsed = parseHandoffDocument(serializeHandoffDocument(claimed));
    expect(parsed.claimed_at).toBe("2026-06-02T10:00:00.000Z");
    expect(parsed.claimed_by).toEqual({
      agent_id: "agent-b",
      harness: "codex",
      source_ref: null,
      cwd: null,
    });
  });

  it("keeps timestamps as strings (not YAML Date)", () => {
    const parsed = parseHandoffDocument(serializeHandoffDocument(handoff));
    expect(typeof parsed.created_at).toBe("string");
  });

  it("rejects a document missing a required field, naming it", () => {
    const raw = serializeHandoffDocument(handoff).replace(/^handoff_id:.*\n/m, "");
    expect(() => parseHandoffDocument(raw)).toThrow(/handoff_id/);
  });
});
