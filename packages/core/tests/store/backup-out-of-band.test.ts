// Out-of-band sweep, wired to the backup (spec 064 T3 / SC 3).
//
// The axis of the substrate is "did THIS actor cause these bytes". A whole-tree
// `commitAll` captures OTHER people's bytes — a hand-edit made straight on disk (an
// Obsidian save, a `git` checkout, a scripted edit outside the store) — so it is
// UNTRAILERED: it exports `actor: null` HONESTLY rather than pinning a stranger's
// edit on whichever actor next wrote. `pushVaultBackup` runs exactly this sweep
// BEFORE the push, so nothing out-of-band is left behind — the wiring the spec's v2
// draft got wrong (it hooked the sweep to `reindex`, which does no git and ships no
// backup). This pins that the out-of-band edit lands in its own untrailered
// `backup: snapshot` commit and reaches the pushed remote.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLibrarianStore } from "@librarian/core";
import { afterEach, describe, expect, it } from "vitest";

const dataDirs: string[] = [];
const remotes: string[] = [];
afterEach(() => {
  for (const dir of dataDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const dir of remotes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function freshDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-oob-"));
  dataDirs.push(dir);
  return dir;
}

function bareRemote(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-oob-remote-"));
  execFileSync("git", ["init", "--bare", dir], { stdio: "ignore" });
  remotes.push(dir);
  return dir;
}

const gitIn = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

describe("out-of-band sweep wired to the backup (spec 064 T3 / SC 3)", () => {
  it("captures a hand-edited file in its own UNTRAILERED backup: snapshot commit and pushes it", () => {
    const dataDir = freshDataDir();
    const store = createLibrarianStore({ dataDir });
    const vaultRoot = path.join(dataDir, "vault");

    // A normal attributed write, so the vault has real history before the sweep.
    store.createMemory({ agent_id: "alice", title: "Runbook", body: "Deploy with plat." });

    // An OUT-OF-BAND edit: a file written straight to disk, never through the store — the
    // shape of an Obsidian save or a hand `git` edit the store never saw.
    fs.mkdirSync(path.join(vaultRoot, "references"), { recursive: true });
    fs.writeFileSync(path.join(vaultRoot, "references", "hand-edited.md"), "# hand edit\n");

    const remote = bareRemote();
    const head = store.pushVaultBackup({
      remoteUrl: remote,
      branch: "main",
      token: "unused-local",
    });
    expect(head).not.toBeNull();

    // HEAD is the out-of-band capture commit.
    expect(gitIn(vaultRoot, ["log", "-1", "--format=%s"])).toBe("backup: snapshot");
    // It carries NO Librarian-Actor trailer — the hand-edit is exported actor:null, honestly.
    expect(
      gitIn(vaultRoot, ["log", "-1", "--format=%(trailers:key=Librarian-Actor,valueonly)"]),
    ).toBe("");
    // The commit contains the hand-edited file.
    const committed = gitIn(vaultRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])
      .split("\n")
      .filter(Boolean);
    expect(committed).toContain("references/hand-edited.md");

    // ...and it reached the pushed backup: the remote HEAD is this commit, and the file is there.
    expect(gitIn(remote, ["rev-parse", "refs/heads/main"])).toBe(head);
    expect(gitIn(remote, ["show", "refs/heads/main:references/hand-edited.md"])).toBe(
      "# hand edit",
    );

    store.close();
  });

  it("a second push with no new out-of-band edits makes no empty commit (whole-tree guard)", () => {
    const dataDir = freshDataDir();
    const store = createLibrarianStore({ dataDir });
    const vaultRoot = path.join(dataDir, "vault");
    store.createMemory({ agent_id: "alice", title: "A", body: "a" });

    const remote = bareRemote();
    store.pushVaultBackup({ remoteUrl: remote, branch: "main", token: "unused-local" });
    const afterFirst = gitIn(vaultRoot, ["rev-parse", "HEAD"]);

    // Nothing changed out of band → the sweep is a no-op → no new commit.
    store.pushVaultBackup({ remoteUrl: remote, branch: "main", token: "unused-local" });
    expect(gitIn(vaultRoot, ["rev-parse", "HEAD"])).toBe(afterFirst);

    store.close();
  });
});
