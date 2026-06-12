// Handoff Zod boundary tests (sessions-rethink spec §6.1 + §6.3).
//
// The store layer trusts validated input, so any contract drift — a missing
// heading, an oversize body, too many tags — must bounce here and never reach
// the store.

import {
  ClaimHandoffInputSchema,
  ListHandoffsInputSchema,
  StoreHandoffInputSchema,
} from "@librarian/core";
import { describe, expect, it } from "vitest";

const validDoc = `# Handoff: test

## Start & intent
the user wanted to do a thing.

## Journey
we tried X then Y.

## Current state
green tests, branch is feat/foo.

## What's left
ship it; write a release note.

## Open questions
do we squash-merge or rebase?
`;

describe("StoreHandoffInputSchema", () => {
  it("accepts a fully-formed handoff with the five required headings", () => {
    const result = StoreHandoffInputSchema.safeParse({
      title: "Continue the migration",
      document_md: validDoc,
      project_key: "proj-x",
      cwd: "/repo",
      harness: "claude-code",
      tags: ["migration", "p1"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects when any required heading is missing", () => {
    for (const heading of [
      "## Start & intent",
      "## Journey",
      "## Current state",
      "## What's left",
      "## Open questions",
    ]) {
      const broken = validDoc.replace(heading, "## Renamed");
      const result = StoreHandoffInputSchema.safeParse({
        title: "a valid title",
        document_md: broken,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toEqual(["document_md"]);
      }
    }
  });

  it("rejects a heading that is not anchored to the start of a line", () => {
    const broken = validDoc.replace("## Journey", "blah ## Journey");
    const result = StoreHandoffInputSchema.safeParse({
      title: "test",
      document_md: broken,
    });
    expect(result.success).toBe(false);
  });

  it("rejects when title is too short or too long", () => {
    expect(StoreHandoffInputSchema.safeParse({ title: "abc", document_md: validDoc }).success).toBe(
      false,
    );
    expect(
      StoreHandoffInputSchema.safeParse({ title: "x".repeat(121), document_md: validDoc }).success,
    ).toBe(false);
  });

  it("rejects when document_md is too short or too long", () => {
    expect(
      StoreHandoffInputSchema.safeParse({ title: "a valid title", document_md: "too short" })
        .success,
    ).toBe(false);
    const oversize = `${validDoc}${"x".repeat(50_001)}`;
    expect(
      StoreHandoffInputSchema.safeParse({ title: "a valid title", document_md: oversize }).success,
    ).toBe(false);
  });

  it("rejects more than ten tags", () => {
    const result = StoreHandoffInputSchema.safeParse({
      title: "a valid title",
      document_md: validDoc,
      tags: Array.from({ length: 11 }, (_, i) => `t${i}`),
    });
    expect(result.success).toBe(false);
  });
});

describe("ListHandoffsInputSchema", () => {
  it("accepts all-optional input and clamps limit bounds", () => {
    expect(ListHandoffsInputSchema.safeParse({}).success).toBe(true);
    expect(ListHandoffsInputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(ListHandoffsInputSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(ListHandoffsInputSchema.safeParse({ limit: 50 }).success).toBe(true);
  });
});

describe("ClaimHandoffInputSchema", () => {
  it("requires handoff_id; other claim metadata is optional", () => {
    expect(ClaimHandoffInputSchema.safeParse({}).success).toBe(false);
    expect(ClaimHandoffInputSchema.safeParse({ handoff_id: "hdo_abc" }).success).toBe(true);
  });
});
