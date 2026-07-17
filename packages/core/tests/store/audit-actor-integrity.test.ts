// Owner vs audit-actor integrity (spec 064 F3/F4) — the write-path fixes that make the actor the
// audit export REPORTS un-forgeable. F3: an admin merge/split may set the created memory's OWNER,
// but the commit TRAILER (the audit actor) is the acting principal, never a body-supplied id. F4:
// a memory written through the vault editor cannot smuggle a false `updated_by` — it is re-stamped
// from the resolved actor. (The read-side twin, SC 7c, lives in audit-export.test.ts.)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  commitSubject,
  createLibrarianStore,
  parseMemoryDocument,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir: string;
let store: LibrarianStore;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-integrity-"));
  store = createLibrarianStore({ dataDir });
});
afterEach(() => {
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** The `Librarian-Actor` trailer of the newest commit whose subject contains `needle`. */
function trailerOf(needle: string): string {
  const out = execFileSync(
    "git",
    [
      "-C",
      path.join(dataDir, "vault"),
      "log",
      "--format=%s\x1f%(trailers:key=Librarian-Actor,valueonly,separator=,)",
    ],
    { encoding: "utf8" },
  );
  for (const line of out.split("\n")) {
    const [subject, trailer] = line.split("\x1f");
    if (subject?.includes(needle)) return (trailer ?? "").trim();
  }
  return "<no such commit>";
}

/** The single memory document's path + parsed frontmatter. */
function theMemory(): { rel: string; updated_by?: string; agent_id: string } {
  const dir = path.join(dataDir, "vault", "memories");
  const file = fs.readdirSync(dir).find((f) => f.endsWith(".md"))!;
  const rel = `memories/${file}`;
  const parsed = parseMemoryDocument(fs.readFileSync(path.join(dir, file), "utf8"));
  return {
    rel,
    agent_id: parsed.agent_id,
    ...(parsed.updated_by !== undefined ? { updated_by: parsed.updated_by } : {}),
  };
}

describe("createMemory owner vs audit actor (spec 064 F3)", () => {
  it("trailers the AUDIT actor, not the OWNER, when they differ (the admin merge/split case)", () => {
    // The merge/split path: a memory OWNED by alice, but the create is the ADMIN's action.
    store.createMemory(
      { title: "Merged fact", body: "collapsed from two", agent_id: "alice" },
      { audit_actor_id: "dashboard-admin" },
    );
    const mem = theMemory();
    // The OWNER is legitimately alice…
    expect(mem.agent_id).toBe("alice");
    // …but the commit is attributed to the ACTING principal, never the body-supplied owner.
    expect(trailerOf("memory: store")).toBe("dashboard-admin");
  });

  it("falls back to the owner when no audit actor is supplied (the ordinary create — unchanged)", () => {
    store.createMemory({ title: "My own fact", body: "self-authored", agent_id: "alice" });
    expect(theMemory().agent_id).toBe("alice");
    expect(trailerOf("memory: store")).toBe("alice"); // owner === actor on a plain create (SC 4)
  });
});

describe("vault-file write re-stamps updated_by (spec 064 F4)", () => {
  it("overwrites a caller-supplied updated_by with the resolved actor", () => {
    store.createMemory({ title: "F4 note", body: "sensitive ops detail", agent_id: "alice" });
    const { rel } = theMemory();
    const raw = store.vaultFiles.readFile(rel).raw;
    // Forge a false last-writer, exactly as a hand-crafted vault-editor save would.
    const forged = raw.replace(/^(updated_at: .*)$/m, "$1\nupdated_by: impersonated-victim");
    expect(forged).toContain("updated_by: impersonated-victim");

    store.vaultFiles.writeFile(rel, forged, {}, "dashboard-admin");
    // The false name never survives: re-stamped from the resolved actor (the memory-verb parity).
    expect(theMemory().updated_by).toBe("dashboard-admin");
  });

  it("strips a caller-supplied updated_by on an anonymous write (an honest null, not a false name)", () => {
    store.createMemory({ title: "F4 anon", body: "body", agent_id: "alice" });
    const { rel } = theMemory();
    const raw = store.vaultFiles.readFile(rel).raw;
    const forged = raw.replace(/^(updated_at: .*)$/m, "$1\nupdated_by: impersonated-victim");

    store.vaultFiles.writeFile(rel, forged, {}, undefined); // no resolvable actor
    expect(theMemory().updated_by).toBeUndefined();
  });

  it("re-stamps updated_by on a RESTORED memory file — no stale historical last-writer (review finding)", () => {
    store.createMemory({ title: "F4 restore", body: "ORIGINAL", agent_id: "alice" });
    const { rel } = theMemory();
    const created = store.vaultFiles.readFile(rel).raw;
    const createCommit = store.vaultFiles.fileHistory(rel).at(-1)!.hash; // oldest = the create
    // bob edits it → updated_by becomes bob.
    store.vaultFiles.writeFile(rel, created.replace("ORIGINAL", "EDITED"), {}, "bob");
    expect(theMemory().updated_by).toBe("bob");
    // carol restores the ORIGINAL version: the bytes are old, but the LAST WRITER is carol — the
    // commit trailer already names carol (F4), so updated_by must agree, not resurrect alice/undefined.
    store.vaultFiles.restoreFileVersion(rel, createCommit, "carol");
    expect(store.vaultFiles.readFile(rel).raw).toContain("ORIGINAL");
    expect(theMemory().updated_by).toBe("carol");
  });
});

describe("commit subjects strip control bytes so the audit reader can't be misframed (review finding)", () => {
  it("removes US/RS/other C0 bytes an interpolated path might smuggle into a subject", () => {
    // The audit reader frames its git-log with \x1f/\x1e and reads the actor trailer off the SAME
    // header line as the subject — a subject carrying a literal \x1f would shift a path fragment into
    // the trailer field and forge an actor on an untrailered commit. `oneLine` strips the whole range.
    const subject = commitSubject.vaultEdit("references/a\x1fb\x1ec.md");
    expect(subject).toBe("vault: edit references/abc.md");
    expect([...subject].every((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)).toBe(
      true,
    );
  });
});
