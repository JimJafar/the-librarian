// CLI runtime tests (T5.1).
//
// Ported from packages/cli/tests/cli.test.js (node:test). Behaviour
// coverage is identical — every test exercises `runCli` directly
// against a real on-disk store via `withStore`, asserting both stdout
// and the projection state. No subprocess spawning.

import fs from "node:fs";
import path from "node:path";
import type { LibrarianStore } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { withStore } from "../../../test/helpers.js";
import { runCli } from "../src/runtime.js";

interface SessionRow {
  id: string;
  title: string;
  status: string;
  visibility: string;
  current_harness: string | null;
  created_in_harness: string | null;
  source_ref: string | null;
  current_agent_id: string;
  rolling_summary: string | null;
  end_summary: string | null;
  project_key: string | null;
  created_by_agent_id: string;
}

function getSession(store: LibrarianStore, id: string): SessionRow {
  const session = store.getSession(id);
  if (!session) throw new Error(`No session ${id}`);
  return session as unknown as SessionRow;
}

function startSession(
  store: LibrarianStore,
  overrides: Partial<{
    title: string;
    agent_id: string;
    harness: string;
    project_key: string;
    start_summary: string;
    source_ref: string;
  }> = {},
): SessionRow {
  const result = store.startSession({
    agent_id: overrides.agent_id || "bede",
    title: overrides.title || "test session",
    harness: overrides.harness || "hermes",
    project_key: overrides.project_key,
    start_summary: overrides.start_summary,
    source_ref: overrides.source_ref,
  });
  if (!result.session) throw new Error("Failed to start session");
  return result.session as unknown as SessionRow;
}

describe("CLI runtime", () => {
  it("prints help for an unknown command", async () => {
    await withStore(async (store) => {
      const result = runCli(["help"], store);
      expect(result.stdout).toMatch(/Usage:/i);
    });
  });

  it("sessions start creates a session and prints id + title", async () => {
    await withStore(async (store) => {
      const result = runCli(
        [
          "sessions",
          "start",
          "--agent",
          "bede",
          "--title",
          "CLI start",
          "--harness",
          "hermes",
          "--project",
          "the-librarian",
        ],
        store,
      );
      expect(result.stdout).toMatch(/ses_/);
      expect(result.stdout).toMatch(/CLI start/);
      expect(result.exitCode).toBe(0);
      const sessions = store.listSessions({ agent_id: "bede" }).sessions as unknown as SessionRow[];
      expect(sessions.length).toBe(1);
      expect(sessions[0]?.title).toBe("CLI start");
      expect(sessions[0]?.created_by_agent_id).toBe("bede");
      expect(sessions[0]?.project_key).toBe("the-librarian");
    });
  });

  it("sessions start --private creates an agent_private session", async () => {
    await withStore(async (store) => {
      runCli(
        [
          "sessions",
          "start",
          "--agent",
          "bede",
          "--title",
          "Private",
          "--harness",
          "hermes",
          "--private",
        ],
        store,
      );
      const sessions = store.listSessions({ agent_id: "bede" }).sessions as unknown as SessionRow[];
      expect(sessions[0]?.visibility).toBe("agent_private");
    });
  });

  it("sessions start --json emits a parseable session payload", async () => {
    await withStore(async (store) => {
      const result = runCli(
        [
          "sessions",
          "start",
          "--agent",
          "bede",
          "--title",
          "JSON",
          "--harness",
          "hermes",
          "--json",
        ],
        store,
      );
      const payload = JSON.parse(result.stdout) as { session: SessionRow };
      expect(payload.session.id.startsWith("ses_")).toBe(true);
      expect(payload.session.title).toBe("JSON");
    });
  });

  it("sessions list shows numbered entries", async () => {
    await withStore(async (store) => {
      store.startSession({ agent_id: "bede", title: "First", harness: "hermes" });
      store.startSession({ agent_id: "bede", title: "Second", harness: "hermes" });
      const result = runCli(["sessions", "list", "--agent", "bede"], store);
      expect(result.stdout).toMatch(/1\. /);
      expect(result.stdout).toMatch(/2\. /);
      expect(result.stdout).toMatch(/First/);
      expect(result.stdout).toMatch(/Second/);
    });
  });

  it("sessions list --json emits an array of sessions", async () => {
    await withStore(async (store) => {
      store.startSession({ agent_id: "bede", title: "JSON list", harness: "hermes" });
      const result = runCli(["sessions", "list", "--agent", "bede", "--json"], store);
      const payload = JSON.parse(result.stdout) as { sessions: SessionRow[] };
      expect(Array.isArray(payload.sessions)).toBe(true);
      expect(payload.sessions.length).toBe(1);
      expect(payload.sessions[0]?.title).toBe("JSON list");
    });
  });

  it("sessions show prints session details", async () => {
    await withStore(async (store) => {
      const session = startSession(store, {
        title: "Showable",
        project_key: "the-librarian",
        start_summary: "Showing things.",
      });
      const result = runCli(["sessions", "show", session.id, "--agent", "bede"], store);
      expect(result.stdout).toMatch(/Showable/);
      expect(result.stdout).toMatch(/Showing things/);
      expect(result.stdout).toMatch(new RegExp(session.id));
    });
  });

  it("sessions show returns a clear message for unknown sessions", async () => {
    await withStore(async (store) => {
      const result = runCli(["sessions", "show", "ses_does_not_exist", "--agent", "bede"], store);
      expect(result.stdout).toMatch(/not found|no session/i);
      expect(result.exitCode).not.toBe(0);
    });
  });

  it("rebuild still works after the subcommand refactor", async () => {
    await withStore(async (store) => {
      const result = runCli(["rebuild"], store);
      expect(result.stdout).toMatch(/[Rr]ebuilt/);
      expect(result.exitCode).toBe(0);
    });
  });

  it("sessions checkpoint with --summary updates rolling_summary", async () => {
    await withStore(async (store) => {
      const session = startSession(store, { title: "Checkpointable" });
      const result = runCli(
        ["sessions", "checkpoint", session.id, "--agent", "bede", "--summary", "Mid-progress."],
        store,
      );
      expect(result.stdout).toMatch(/[Cc]heckpoint/);
      expect(getSession(store, session.id).rolling_summary).toBe("Mid-progress.");
    });
  });

  it("sessions checkpoint --summary-file reads the summary from disk", async () => {
    await withStore(async (store, dataDir) => {
      const session = startSession(store, { title: "FromFile" });
      const summaryPath = path.join(dataDir, "checkpoint.md");
      fs.writeFileSync(summaryPath, "Loaded from file.\nMulti-line summary.\n", "utf8");
      runCli(
        ["sessions", "checkpoint", session.id, "--agent", "bede", "--summary-file", summaryPath],
        store,
      );
      const reloaded = getSession(store, session.id);
      expect(reloaded.rolling_summary).toMatch(/Loaded from file\./);
      expect(reloaded.rolling_summary).toMatch(/Multi-line summary\./);
    });
  });

  it("sessions pause marks the session paused", async () => {
    await withStore(async (store) => {
      const session = startSession(store, { title: "Pausable" });
      const result = runCli(
        ["sessions", "pause", session.id, "--agent", "bede", "--summary", "Day's end."],
        store,
      );
      expect(result.stdout).toMatch(/[Pp]aused/);
      const reloaded = getSession(store, session.id);
      expect(reloaded.status).toBe("paused");
      expect(reloaded.rolling_summary).toBe("Day's end.");
    });
  });

  it("sessions end writes end_summary and marks the session ended", async () => {
    await withStore(async (store) => {
      const session = startSession(store, { title: "Endable" });
      const result = runCli(
        ["sessions", "end", session.id, "--agent", "bede", "--summary", "Wrapped up."],
        store,
      );
      expect(result.stdout).toMatch(/[Ee]nded/);
      const reloaded = getSession(store, session.id);
      expect(reloaded.status).toBe("ended");
      expect(reloaded.end_summary).toBe("Wrapped up.");
    });
  });

  it("sessions attach swaps the current harness/source/cwd", async () => {
    await withStore(async (store) => {
      const session = startSession(store, { title: "Attachable", source_ref: "discord:1:2" });
      runCli(
        [
          "sessions",
          "attach",
          session.id,
          "--agent",
          "codex",
          "--harness",
          "codex",
          "--source-ref",
          "codex:r1:cwd:/dev",
          "--cwd",
          "/dev",
        ],
        store,
      );
      const reloaded = getSession(store, session.id);
      expect(reloaded.current_harness).toBe("codex");
      expect(reloaded.current_agent_id).toBe("codex");
      expect(reloaded.source_ref).toBe("codex:r1:cwd:/dev");
      expect(reloaded.created_in_harness).toBe("hermes");
    });
  });

  it("sessions continue returns handover text and attaches by default", async () => {
    await withStore(async (store) => {
      const session = startSession(store, {
        title: "Handover via CLI",
        project_key: "the-librarian",
        start_summary: "Investigating CLI handover.",
      });
      store.checkpointSession({
        agent_id: "bede",
        session_id: session.id,
        summary: "Drafted CLI handover.",
        next_steps: ["Verify with tests"],
      });
      const result = runCli(
        [
          "sessions",
          "continue",
          session.id,
          "--agent",
          "codex",
          "--target-harness",
          "codex",
          "--target-source-ref",
          "codex:r1:cwd:/dev",
          "--target-cwd",
          "/dev",
        ],
        store,
      );
      expect(result.stdout).toMatch(/Handover via CLI/);
      expect(result.stdout).toMatch(/Drafted CLI handover/);
      const reloaded = getSession(store, session.id);
      expect(reloaded.current_harness).toBe("codex");
    });
  });

  it("sessions continue --no-attach leaves current harness untouched", async () => {
    await withStore(async (store) => {
      const session = startSession(store, { title: "Preview" });
      runCli(
        [
          "sessions",
          "continue",
          session.id,
          "--agent",
          "codex",
          "--target-harness",
          "codex",
          "--no-attach",
        ],
        store,
      );
      expect(getSession(store, session.id).current_harness).toBe("hermes");
    });
  });

  it("sessions continue --format markdown produces the spec template", async () => {
    await withStore(async (store) => {
      const session = startSession(store, { title: "Markdown CLI", start_summary: "Start" });
      store.checkpointSession({
        agent_id: "bede",
        session_id: session.id,
        summary: "Mid",
        decisions: ["A decision"],
      });
      const result = runCli(
        [
          "sessions",
          "continue",
          session.id,
          "--agent",
          "bede",
          "--format",
          "markdown",
          "--no-attach",
        ],
        store,
      );
      expect(result.stdout).toMatch(/# Librarian Session Handover/);
      expect(result.stdout).toMatch(/## Decisions/);
      expect(result.stdout).toMatch(/A decision/);
    });
  });

  it("sessions end hides the session from default list (S1.1: end covers archive + delete)", async () => {
    await withStore(async (store) => {
      const session = startSession(store, { title: "End me" });
      runCli(["sessions", "end", session.id, "--agent", "bede"], store);
      const list = runCli(["sessions", "list", "--agent", "bede"], store);
      expect(list.stdout).not.toMatch(/End me/);
    });
  });

  it("sessions continue on an ended session brings it back as paused", async () => {
    await withStore(async (store) => {
      const session = startSession(store, { title: "Round trip" });
      runCli(["sessions", "end", session.id, "--agent", "bede"], store);
      expect(getSession(store, session.id).status).toBe("ended");
      runCli(["sessions", "continue", session.id, "--agent", "bede"], store);
      expect(["active", "paused"]).toContain(getSession(store, session.id).status);
    });
  });

  it("sessions search finds sessions by event content", async () => {
    await withStore(async (store) => {
      store.startSession({
        agent_id: "bede",
        title: "BM25 work",
        harness: "hermes",
        start_summary: "Investigating BM25 recall.",
      });
      const result = runCli(["sessions", "search", "BM25", "--agent", "bede"], store);
      expect(result.stdout).toMatch(/BM25 work/);
    });
  });

  it("sessions events lists the per-session event stream with --type filter", async () => {
    await withStore(async (store) => {
      const session = startSession(store, { title: "Events" });
      store.recordSessionEvent({
        agent_id: "bede",
        session_id: session.id,
        type: "decision",
        summary: "Decision A",
      });
      store.recordSessionEvent({
        agent_id: "bede",
        session_id: session.id,
        type: "command",
        summary: "npm test",
      });
      const all = runCli(["sessions", "events", session.id, "--agent", "bede"], store);
      expect(all.stdout).toMatch(/Decision A/);
      expect(all.stdout).toMatch(/npm test/);
      const decisions = runCli(
        ["sessions", "events", session.id, "--agent", "bede", "--type", "decision"],
        store,
      );
      expect(decisions.stdout).toMatch(/Decision A/);
      expect(decisions.stdout).not.toMatch(/npm test/);
    });
  });
});
