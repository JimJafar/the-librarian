// Memory write-routing truth table (extracted from memory-store.ts so every
// backend shares one implementation — plan 036 Phase 2).
//
// The routing decides, from a write's options, whether a memory lands
// `active` or `proposed`. Post-rethink T4 (D7: classifier deleted) the
// decision reads only the plain trusted-options booleans —
// `requires_approval` / `is_global` from caller/curator/admin — plus the
// explicit `status` override and curator_note provenance. Agent-supplied
// input values are ignored upstream.

import { routeMemoryWrite } from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("routeMemoryWrite", () => {
  it("defaults to the normalized status with no protection signals", () => {
    expect(routeMemoryWrite("active", {})).toEqual({
      status: "active",
      isGlobal: false,
      requiresApproval: false,
      curatorNote: null,
    });
  });

  it("explicit requires_approval → proposed", () => {
    expect(routeMemoryWrite("active", { requires_approval: true })).toEqual({
      status: "proposed",
      isGlobal: false,
      requiresApproval: true,
      curatorNote: null,
    });
  });

  it("explicit is_global is honoured and never affects the landing status", () => {
    expect(routeMemoryWrite("active", { is_global: true })).toEqual({
      status: "active",
      isGlobal: true,
      requiresApproval: false,
      curatorNote: null,
    });
  });

  it("an explicit options.status overrides the routing", () => {
    expect(routeMemoryWrite("active", { requires_approval: true, status: "active" })).toMatchObject(
      {
        status: "active",
        requiresApproval: true,
      },
    );
  });

  it("ignores the retired classifier-era options (pendingClassification / outsideSession / forceActive)", () => {
    // rethink T4 (D7): the classifier and its cutover plumbing are deleted —
    // a stale caller passing the old signals gets plain default routing.
    expect(
      routeMemoryWrite("active", {
        pendingClassification: true,
        outsideSession: true,
        forceActive: true,
      }),
    ).toEqual({
      status: "active",
      isGlobal: false,
      requiresApproval: false,
      curatorNote: null,
    });
  });

  it("accepts a curator_note object via the trusted options channel only", () => {
    expect(routeMemoryWrite("active", { curator_note: { source: "curator" } }).curatorNote).toEqual(
      {
        source: "curator",
      },
    );
    expect(routeMemoryWrite("active", { curator_note: "nope" }).curatorNote).toBeNull();
  });
});
