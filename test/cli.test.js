import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../src/cli.js";
import { withStore } from "./helpers.js";

test("CLI prints help for an unknown command", async () => {
  await withStore(async (store) => {
    const result = await runCli(["help"], store);
    assert.match(result.stdout, /Usage:/i);
  });
});

test("CLI sessions start creates a session and prints id + title", async () => {
  await withStore(async (store) => {
    const result = await runCli(
      ["sessions", "start", "--agent", "bede", "--title", "CLI start", "--harness", "hermes", "--project", "the-librarian"],
      store
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
      ["sessions", "start", "--agent", "bede", "--title", "Private", "--harness", "hermes", "--private"],
      store
    );
    const sessions = store.listSessions({ agent_id: "bede" }).sessions;
    assert.equal(sessions[0].visibility, "agent_private");
  });
});

test("CLI sessions start --json emits a parseable session payload", async () => {
  await withStore(async (store) => {
    const result = await runCli(
      ["sessions", "start", "--agent", "bede", "--title", "JSON", "--harness", "hermes", "--json"],
      store
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
      start_summary: "Showing things."
    });

    const result = await runCli(["sessions", "show", session.id, "--agent", "bede"], store);
    assert.match(result.stdout, /Showable/);
    assert.match(result.stdout, /Showing things/);
    assert.match(result.stdout, new RegExp(session.id));
  });
});

test("CLI sessions show returns a clear message for unknown sessions", async () => {
  await withStore(async (store) => {
    const result = await runCli(["sessions", "show", "ses_does_not_exist", "--agent", "bede"], store);
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
