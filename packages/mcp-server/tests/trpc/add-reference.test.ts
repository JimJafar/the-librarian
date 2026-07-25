// `vault.addReference` — spec 073 T5 (SC 7, 8, 12).
//
// The dashboard's door into references/. Member-tier by decision (Jim,
// 25/07/2026): consistent with the existing trust model rather than a widening,
// since the /ingest URL path is already reachable with a capture-scoped token
// and it is the SSRF guard — not the tier — that makes fetching safe.
//
// Member tier is what makes the attribution load-bearing: the write must be
// principal-scoped and the commit must carry THAT MEMBER's actor trailer, not
// the server's. With an admin-only mutation that would have been trivially
// satisfied and never tested.

import { spawnSync } from "node:child_process";
import path from "node:path";
import type { Principal } from "@librarian/core";
import { createLibrarianStore } from "@librarian/core";
import { appRouter, createCallerFactory } from "@librarian/mcp-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../test/helpers.js";
import type { TrpcContext } from "../../dist/trpc/context.js";

const createCaller = createCallerFactory(appRouter);

// The CANONICAL id form. `resolveCaller` folds a provider's `member:alice`
// to `member-alice` before it reaches a store write (caller-identity.ts:347),
// and `actorTrailerValue` only emits ids matching that canonical syntax — so a
// colon-bearing id would silently produce a commit with NO attribution.
const memberPrincipal: Principal = {
  kind: "member",
  actorId: "member-alice",
  roles: ["member"],
  attrs: { memberId: "alice" },
};

const anonymousPrincipal: Principal = { kind: "agent", actorId: "anonymous", roles: [] };

function contextFor(principal: Principal, store: TrpcContext["store"]): TrpcContext {
  return {
    principal,
    role: principal.roles.includes("admin") ? "admin" : "anonymous",
    store,
    secretKey: null,
    adminToken: "",
  };
}

/** The `Librarian-Actor` trailer of the newest commit whose subject matches. */
function trailerOf(dataDir: string, needle: string): string {
  const result = spawnSync(
    "git",
    [
      "-C",
      path.join(dataDir, "vault"),
      "log",
      "--format=%s\x1f%(trailers:key=Librarian-Actor,valueonly,separator=,)",
    ],
    { encoding: "utf8" },
  );
  for (const line of result.stdout.split("\n")) {
    const [subject, trailer] = line.split("\x1f");
    if (subject?.includes(needle)) return (trailer ?? "").trim();
  }
  return "<no such commit>";
}

describe("vault.addReference (spec 073 SC 7)", () => {
  let dataDir = "";
  let store: ReturnType<typeof createLibrarianStore>;

  beforeEach(() => {
    dataDir = makeTempDir();
    store = createLibrarianStore({ dataDir });
  });
  afterEach(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    cleanupTempDir(dataDir);
  });

  it("files pasted Markdown as a reference and reports the path", async () => {
    const caller = createCaller(contextFor(memberPrincipal, store));

    const result = await caller.vault.addReference({
      content: "# Deploy policy\n\nNever on a Friday.\n",
    });

    expect(result.path).toMatch(/^references\/.*\.md$/);
    expect(store.vaultFiles.readFile(result.path).raw).toContain("Never on a Friday.");
  });

  it("keeps frontmatter the pasted text already carried", async () => {
    const caller = createCaller(contextFor(memberPrincipal, store));

    const result = await caller.vault.addReference({
      content: ["---", "title: Kept", "tags:", "  - keepme", "---", "", "body", ""].join("\n"),
    });

    const raw = store.vaultFiles.readFile(result.path).raw;
    expect(raw).toContain("title: Kept");
    expect(raw).toContain("keepme");
  });

  it("uses the supplied title when the text has none", async () => {
    const caller = createCaller(contextFor(memberPrincipal, store));

    const result = await caller.vault.addReference({
      content: "no heading at all",
      title: "Release runbook",
    });

    expect(result.path).toBe("references/release-runbook.md");
  });

  it("records how it arrived (SC 8)", async () => {
    const caller = createCaller(contextFor(memberPrincipal, store));

    const result = await caller.vault.addReference({ content: "# A\n\nbody\n" });

    expect(store.vaultFiles.readFile(result.path).raw).toContain("via: dashboard");
  });

  it("refuses an empty submission with a teaching message", async () => {
    const caller = createCaller(contextFor(memberPrincipal, store));

    await expect(caller.vault.addReference({ content: "   " })).rejects.toThrow(
      /content|url|empty/i,
    );
  });

  it("refuses when neither content nor url is given", async () => {
    const caller = createCaller(contextFor(memberPrincipal, store));
    await expect(caller.vault.addReference({})).rejects.toThrow(/content|url/i);
  });

  it("refuses a second reference at the same path rather than overwriting", async () => {
    const caller = createCaller(contextFor(memberPrincipal, store));
    await caller.vault.addReference({ content: "# Same\n\nfirst\n" });

    await expect(caller.vault.addReference({ content: "# Same\n\nsecond\n" })).rejects.toThrow(
      /already exists/i,
    );
    expect(store.vaultFiles.readFile("references/same.md").raw).toContain("first");
  });
});

describe("vault.addReference — tier and attribution (spec 073 SC 12)", () => {
  let dataDir = "";
  let store: ReturnType<typeof createLibrarianStore>;

  beforeEach(() => {
    dataDir = makeTempDir();
    store = createLibrarianStore({ dataDir });
  });
  afterEach(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    cleanupTempDir(dataDir);
  });

  it("commits under the MEMBER's actor id, not the server's", async () => {
    const caller = createCaller(contextFor(memberPrincipal, store));

    const result = await caller.vault.addReference({ content: "# Attributed\n\nbody\n" });

    expect(trailerOf(dataDir, result.path)).toBe("member-alice");
  });

  it("is closed to an anonymous caller", async () => {
    const caller = createCaller(contextFor(anonymousPrincipal, store));

    await expect(caller.vault.addReference({ content: "# Nope\n\nbody\n" })).rejects.toThrow(
      /UNAUTHORIZED/,
    );
  });
});
