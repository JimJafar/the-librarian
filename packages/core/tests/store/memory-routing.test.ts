// Memory write-routing truth table (extracted from memory-store.ts so the
// SQLite and markdown backends share one implementation — plan 036 Phase 2).
//
// The routing decides, from a write's options, whether a memory lands
// `active` or `proposed` and the classifier-verdict booleans. Pinning the
// matrix here keeps both stores honest. Section 4d.3 — the protected-routing
// decision reads explicit signals only (pendingClassification / outsideSession
// / options.requires_approval); agent-supplied input values are ignored
// upstream.

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

  it("pendingClassification → proposed + requiresApproval, isGlobal forced false", () => {
    expect(routeMemoryWrite("active", { pendingClassification: true, is_global: true })).toEqual({
      status: "proposed",
      isGlobal: false,
      requiresApproval: true,
      curatorNote: null,
    });
  });

  it("outsideSession → proposed + requiresApproval; explicit is_global honoured", () => {
    expect(routeMemoryWrite("active", { outsideSession: true, is_global: true })).toEqual({
      status: "proposed",
      isGlobal: true,
      requiresApproval: true,
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

  it("forceActive keeps status active even though requiresApproval stays true", () => {
    expect(routeMemoryWrite("active", { requires_approval: true, forceActive: true })).toEqual({
      status: "active",
      isGlobal: false,
      requiresApproval: true,
      curatorNote: null,
    });
  });

  it("an explicit options.status overrides the routing", () => {
    expect(
      routeMemoryWrite("active", { pendingClassification: true, status: "active" }),
    ).toMatchObject({
      status: "active",
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
