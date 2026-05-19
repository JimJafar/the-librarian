import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { withStore } from "../../../test/helpers.js";
import { runCli } from "../src/cli.js";

test("CLI prints help for an unknown command", async () => {
  await withStore(async (store) => {
    const result = await runCli(["help"], store);
    assert.match(result.stdout, /Usage:/i);
  });
});

test("CLI sessions start creates a session and prints id + title", async () => {
  await withStore(async (store) => {
    const result = await runCli(
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
    assert.match(result.stdout, /ses_/);
    assert.match(result.stdout, /CLI start/);
    assert.equal(result.exitCode, 0);

    const sessions = store.listSessions({ agent_id: "bede" }).sessions;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].title, "CLI start");
    assert.equal(sessions[0].created_by_agent_id, "bede");
    assert.equal(sessions[0].project_key, "the-librarian");
  });
});

test("CLI sessions start --private creates an agent_private session", async () => {
  await withStore(async (store) => {
    await runCli(
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
    const sessions = store.listSessions({ agent_id: "bede" }).sessions;
    assert.equal(sessions[0].visibility, "agent_private");
  });
});

test("CLI sessions start --json emits a parseable session payload", async () => {
  await withStore(async (store) => {
    const result = await runCli(
      ["sessions", "start", "--agent", "bede", "--title", "JSON", "--harness", "hermes", "--json"],
      store,
    );
    const payload = JSON.parse(result.stdout);
    assert.ok(payload.session.id.startsWith("ses_"));
    assert.equal(payload.session.title, "JSON");
  });
});

test("CLI sessions list shows numbered entries", async () => {
  await withStore(async (store) => {
    store.startSession({ agent_id: "bede", title: "First", harness: "hermes" });
    store.startSession({ agent_id: "bede", title: "Second", harness: "hermes" });

    const result = await runCli(["sessions", "list", "--agent", "bede"], store);
    assert.match(result.stdout, /1\. /);
    assert.match(result.stdout, /2\. /);
    assert.match(result.stdout, /First/);
    assert.match(result.stdout, /Second/);
  });
});

test("CLI sessions list --json emits an array of sessions", async () => {
  await withStore(async (store) => {
    store.startSession({ agent_id: "bede", title: "JSON list", harness: "hermes" });
    const result = await runCli(["sessions", "list", "--agent", "bede", "--json"], store);
    const payload = JSON.parse(result.stdout);
    assert.ok(Array.isArray(payload.sessions));
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.sessions[0].title, "JSON list");
  });
});

test("CLI sessions show prints session details", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Showable",
      harness: "hermes",
      project_key: "the-librarian",
      start_summary: "Showing things.",
    });

    const result = await runCli(["sessions", "show", session.id, "--agent", "bede"], store);
    assert.match(result.stdout, /Showable/);
    assert.match(result.stdout, /Showing things/);
    assert.match(result.stdout, new RegExp(session.id));
  });
});

test("CLI sessions show returns a clear message for unknown sessions", async () => {
  await withStore(async (store) => {
    const result = await runCli(
      ["sessions", "show", "ses_does_not_exist", "--agent", "bede"],
      store,
    );
    assert.match(result.stdout, /not found|no session/i);
    assert.notEqual(result.exitCode, 0);
  });
});

test("CLI rebuild still works after the subcommand refactor", async () => {
  await withStore(async (store) => {
    const result = await runCli(["rebuild"], store);
    assert.match(result.stdout, /[Rr]ebuilt/);
    assert.equal(result.exitCode, 0);
  });
});

test("CLI sessions checkpoint with --summary updates rolling_summary", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Checkpointable",
      harness: "hermes",
    });
    const result = await runCli(
      ["sessions", "checkpoint", session.id, "--agent", "bede", "--summary", "Mid-progress."],
      store,
    );
    assert.match(result.stdout, /[Cc]heckpoint/);
    assert.equal(store.getSession(session.id).rolling_summary, "Mid-progress.");
  });
});

test("CLI sessions checkpoint --summary-file reads the summary from disk", async () => {
  await withStore(async (store, dataDir) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "FromFile",
      harness: "hermes",
    });
    const summaryPath = path.join(dataDir, "checkpoint.md");
    fs.writeFileSync(summaryPath, "Loaded from file.\nMulti-line summary.\n", "utf8");

    await runCli(
      ["sessions", "checkpoint", session.id, "--agent", "bede", "--summary-file", summaryPath],
      store,
    );
    const reloaded = store.getSession(session.id);
    assert.match(reloaded.rolling_summary, /Loaded from file\./);
    assert.match(reloaded.rolling_summary, /Multi-line summary\./);
  });
});

test("CLI sessions pause marks the session paused", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Pausable",
      harness: "hermes",
    });
    const result = await runCli(
      ["sessions", "pause", session.id, "--agent", "bede", "--summary", "Day's end."],
      store,
    );
    assert.match(result.stdout, /[Pp]aused/);
    const reloaded = store.getSession(session.id);
    assert.equal(reloaded.status, "paused");
    assert.equal(reloaded.rolling_summary, "Day's end.");
  });
});

test("CLI sessions end writes end_summary and marks the session ended", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Endable",
      harness: "hermes",
    });
    const result = await runCli(
      ["sessions", "end", session.id, "--agent", "bede", "--summary", "Wrapped up."],
      store,
    );
    assert.match(result.stdout, /[Ee]nded/);
    const reloaded = store.getSession(session.id);
    assert.equal(reloaded.status, "ended");
    assert.equal(reloaded.end_summary, "Wrapped up.");
  });
});

test("CLI sessions attach swaps the current harness/source/cwd", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Attachable",
      harness: "hermes",
      source_ref: "discord:1:2",
    });
    await runCli(
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
    const reloaded = store.getSession(session.id);
    assert.equal(reloaded.current_harness, "codex");
    assert.equal(reloaded.current_agent_id, "codex");
    assert.equal(reloaded.source_ref, "codex:r1:cwd:/dev");
    assert.equal(reloaded.created_in_harness, "hermes", "origin preserved");
  });
});

test("CLI sessions continue returns handover text and attaches by default", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Handover via CLI",
      harness: "hermes",
      project_key: "the-librarian",
      start_summary: "Investigating CLI handover.",
    });
    store.checkpointSession({
      agent_id: "bede",
      session_id: session.id,
      summary: "Drafted CLI handover.",
      next_steps: ["Verify with tests"],
    });

    const result = await runCli(
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

    assert.match(result.stdout, /Handover via CLI/);
    assert.match(result.stdout, /Drafted CLI handover/);
    const reloaded = store.getSession(session.id);
    assert.equal(
      reloaded.current_harness,
      "codex",
      "default attach=true should switch current harness",
    );
  });
});

test("CLI sessions continue --no-attach leaves current harness untouched", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Preview",
      harness: "hermes",
    });

    await runCli(
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
    const reloaded = store.getSession(session.id);
    assert.equal(reloaded.current_harness, "hermes");
  });
});

test("CLI sessions continue --format markdown produces the spec template", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Markdown CLI",
      harness: "hermes",
      start_summary: "Start",
    });
    store.checkpointSession({
      agent_id: "bede",
      session_id: session.id,
      summary: "Mid",
      decisions: ["A decision"],
    });

    const result = await runCli(
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
    assert.match(result.stdout, /# Librarian Session Handover/);
    assert.match(result.stdout, /## Decisions/);
    assert.match(result.stdout, /A decision/);
  });
});

test("CLI sessions archive hides the session from default list", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Archive me",
      harness: "hermes",
    });
    await runCli(["sessions", "archive", session.id, "--agent", "bede", "--reason", "tidy"], store);

    const list = await runCli(["sessions", "list", "--agent", "bede"], store);
    assert.doesNotMatch(list.stdout, /Archive me/);
  });
});

test("CLI sessions delete and restore round-trip an owned session", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Round trip",
      harness: "hermes",
    });
    await runCli(["sessions", "delete", session.id, "--agent", "bede"], store);
    assert.equal(store.getSession(session.id).status, "deleted");

    await runCli(["sessions", "restore", session.id, "--agent", "bede"], store);
    assert.equal(store.getSession(session.id).status, "active");
  });
});

test("CLI sessions delete refuses non-owner without --admin and surfaces a clear error", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Bede's",
      harness: "hermes",
    });
    const result = await runCli(["sessions", "delete", session.id, "--agent", "codex"], store);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stdout, /owner|admin|permission/i);
    assert.equal(store.getSession(session.id).status, "active");
  });
});

test("CLI sessions search finds sessions by event content", async () => {
  await withStore(async (store) => {
    store.startSession({
      agent_id: "bede",
      title: "BM25 work",
      harness: "hermes",
      start_summary: "Investigating BM25 recall.",
    });

    const result = await runCli(["sessions", "search", "BM25", "--agent", "bede"], store);
    assert.match(result.stdout, /BM25 work/);
  });
});

test("CLI sessions events lists the per-session event stream with --type filter", async () => {
  await withStore(async (store) => {
    const { session } = store.startSession({
      agent_id: "bede",
      title: "Events",
      harness: "hermes",
    });
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

    const all = await runCli(["sessions", "events", session.id, "--agent", "bede"], store);
    assert.match(all.stdout, /Decision A/);
    assert.match(all.stdout, /npm test/);

    const decisions = await runCli(
      ["sessions", "events", session.id, "--agent", "bede", "--type", "decision"],
      store,
    );
    assert.match(decisions.stdout, /Decision A/);
    assert.doesNotMatch(decisions.stdout, /npm test/);
  });
});
