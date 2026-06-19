import { type LibrarianStore } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { withStore } from "../../../test/helpers.js";
import { runCli } from "../src/runtime.js";

function seed(store: LibrarianStore, title: string) {
  store.createMemory({
    agent_id: "claude",
    title,
    body: "body",
    visibility: "common",
    confidence: "working",
  });
}

describe("the-librarian backup / export", () => {
  // The push mechanics (and token-safety) are covered by the git-ops + store tests;
  // here we just pin the CLI's no-remote guard. The happy path pushes to github.com,
  // which a unit test can't exercise.
  it("backup reports when no remote is configured", async () => {
    await withStore(async (store: LibrarianStore) => {
      seed(store, "one");
      const r = runCli(["backup"], store);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("No backup remote configured");
    });
  });

  it("export --format json dumps memories", async () => {
    await withStore(async (store: LibrarianStore) => {
      seed(store, "one");
      const r = runCli(["export", "--format", "json"], store);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout).memories.length).toBe(1);
    });
  });
});
