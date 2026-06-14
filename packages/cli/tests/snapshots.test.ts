// CLI help snapshots.
//
// Pins the textual help screens (top-level + handoffs) so any unintended
// drift to either surface fails these tests rather than slipping into the
// wrappers and dashboards downstream.

import { describe, expect, it } from "vitest";
import { handoffsUsage, usage } from "../src/runtime.js";

describe("CLI snapshots", () => {
  it("top-level help matches snapshot", () => {
    expect(usage()).toMatchInlineSnapshot(`
      "Usage: the-librarian <command>

      Commands:
        rebuild                       Rebuild the memory index from stored data
        seed                          Seed sample memories (no-op if any exist)
        backup                        Push the memory vault to the configured GitHub remote
        restore [--secret-key <hex>] [--force]
                                      Clone the backup remote into the data dir (re-supply the master key)
        export [--format ndjson|json] Dump memories to stdout
        migrate-data-dir [--data-dir <path>]
                                      Migrate a pre-1.0 data dir (reports, never deletes)
        handoffs <verb>               Inspect cross-harness handoffs (see 'handoffs help')
        auth <verb>                   Recover dashboard auth (see 'auth help')"
    `);
  });

  it("handoffs help matches snapshot", () => {
    expect(handoffsUsage()).toMatchInlineSnapshot(`
      "Usage: the-librarian handoffs <verb> [args] [flags]

      Verbs:
        list                          List handoffs (default: unclaimed)
        show <handoff_id>             Show a single handoff (including its document)
        purge <handoff_id>            Admin-only — hard-delete a handoff row

      Common flags:
        --project <key>               Filter by project_key
        --cwd <path>                  Filter by cwd
        --harness <name>              Filter by created_in_harness
        --limit <n>                   list: max rows (default 20, max 100)
        --include-claimed             list: include already-claimed handoffs (default: hide)
        --admin                       purge: required
        --json                        Emit JSON instead of prose"
    `);
  });
});
