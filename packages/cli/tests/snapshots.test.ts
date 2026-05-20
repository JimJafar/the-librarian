// CLI help + --json output snapshots (T5.2).
//
// Pins the textual help screens (top-level + sessions) and the JSON
// shapes returned by --json for the read-only verbs. Any unintended
// drift to either surface during T5.x or beyond fails these tests
// rather than slipping into the wrappers and dashboards downstream.
//
// Mutation-side JSON (start/checkpoint/pause/...) embeds opaque ids
// and timestamps, so they're not pinned here — the behavioural tests
// in cli.test.ts already cover them.

import { describe, expect, it } from "vitest";
import { withStore } from "../../../test/helpers.js";
import { runCli, sessionsUsage, usage } from "../src/runtime.js";

describe("CLI snapshots", () => {
  it("top-level help matches snapshot", () => {
    expect(usage()).toMatchInlineSnapshot(`
      "Usage: the-librarian <command>

      Commands:
        rebuild                       Replay events.jsonl and sessions.jsonl into the SQLite projection
        seed                          Seed sample memories (no-op if any exist)
        sessions <verb>               Manage Librarian sessions (see 'sessions help')"
    `);
  });

  it("sessions help matches snapshot", () => {
    expect(sessionsUsage()).toMatchInlineSnapshot(`
      "Usage: the-librarian sessions <verb> [args] [flags]

      Verbs:
        start                         Start a new session
        list                          List resumable sessions
        show <session_id>             Show a single session in full
        checkpoint <session_id>       Update rolling_summary (use --summary or --summary-file)
        pause <session_id>            Mark paused with a summary
        end <session_id>              End the session with end_summary
        attach <session_id>           Record attachment to the caller's harness/source
        continue <session_id>         Generate a handover package; default attaches
        archive <session_id>          Hide from default lists
        restore <session_id>          Restore an archived or deleted session
        delete <session_id>           Soft-delete (owner-or-admin only)
        search <query>                Full-text search across session events
        events <session_id>           List per-session event stream

      Common flags:
        --agent <id>                  Caller agent id (default: $LIBRARIAN_AGENT_ID or 'cli')
        --admin                       Elevate to admin role (allows cross-agent delete/restore)
        --project <key>               Scope to a project
        --harness <name>              Caller harness identifier
        --cwd <path>                  Caller working directory
        --source-ref <ref>            Caller source reference (e.g. discord:channel:.../thread:...)
        --json                        Emit JSON instead of prose
        --format <name>               continue: prose|markdown|claude|codex|opencode|hermes|pi
        --summary-file <path>         checkpoint/pause/end: read summary from a file
        --no-attach                   continue: skip attachment (preview only)"
    `);
  });

  it("sessions list --json shape is empty + bounded by limit", async () => {
    await withStore(async (store) => {
      const result = runCli(["sessions", "list", "--agent", "bede", "--json"], store);
      const payload = JSON.parse(result.stdout) as {
        sessions: unknown[];
        total: number;
        limit: number;
      };
      expect(Object.keys(payload).sort()).toEqual(["limit", "sessions", "total"]);
      expect(payload.sessions).toEqual([]);
      expect(payload.total).toBe(0);
      expect(typeof payload.limit).toBe("number");
    });
  });

  it("sessions events --json shape is { events, total, limit, offset }", async () => {
    await withStore(async (store) => {
      const start = store.startSession({
        agent_id: "bede",
        title: "Snapshot events",
        harness: "hermes",
      });
      const sessionId = start.session?.id;
      if (!sessionId) throw new Error("Failed to seed session for snapshot");
      const result = runCli(["sessions", "events", sessionId, "--agent", "bede", "--json"], store);
      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(["events", "limit", "offset", "total"]);
      expect(Array.isArray(payload.events)).toBe(true);
      expect(typeof payload.total).toBe("number");
    });
  });

  it("unknown verb prints the sessions usage and exits non-zero", async () => {
    await withStore(async (store) => {
      const result = runCli(["sessions", "no-such-verb"], store);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toMatch(/Unknown sessions verb: no-such-verb/);
      expect(result.stdout).toContain("Usage: the-librarian sessions");
    });
  });
});
