// Shelf-aware /ingest reference capture (spec 062 T6 — SC 8b). Captured references land on the
// CAPTURING principal's write-target shelf: the processors stay shelf-IGNORANT (they still mint
// `references/web/…`), and the route/store boundary prepends the prefix by handing them the
// shelf-scoped vault-file surface. This test drives the EXACT composition the /ingest route uses —
// `{ ...store, vaultFiles: store.forShelf(store.resolveWriteTarget(principal)).vaultFiles }` — over a
// two-shelf router, then asserts the reference file lands beneath `members/x/`. The default router
// (write-target = the vault-root shelf) leaves the minted path byte-identical.
//
// NOTE (review D): this pins the composition at the CORE level but hand-copies the route's
// captureStore shape, so a reverted route would still pass here. The PRODUCTION wiring (real factory +
// router + HTTP, and the fail-soft markFailed path on a read-only write-target) is now driven end to
// end by the `/ingest` leg of the Teams e2e (mcp-server/tests/teams-shape-live.test.ts).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ContentCaptureStore,
  type LibrarianStore,
  type Principal,
  type Shelf,
  type VaultRouter,
  createLibrarianStore,
  processContentCapture,
  processTextCapture,
  recordPending,
} from "@librarian/core";
import { afterEach, describe, expect, it } from "vitest";

const A: Shelf = { id: "members-x", prefix: "members/x/", writable: true, label: "Sarah's shelf" };
const B: Shelf = { id: "team", prefix: "team/", writable: false };
const router: VaultRouter = {
  shelves: (_p, op) => (op === "write" ? [A] : [A, B]),
  writeTarget: () => A,
};
const SARAH: Principal = { kind: "agent", actorId: "sarah", roles: ["agent"] };

const stores: LibrarianStore[] = [];
const dataDirs: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      /* ignore */
    }
  }
  for (const dir of dataDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function freshStore(vaultRouter?: VaultRouter): { store: LibrarianStore; vaultDir: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-ingest-shelf-"));
  dataDirs.push(dataDir);
  const store = createLibrarianStore({ dataDir, ...(vaultRouter ? { vaultRouter } : {}) });
  stores.push(store);
  return { store, vaultDir: path.join(dataDir, "vault") };
}

/**
 * The route's capture-store composition (spec 062 SC 8b): shared settings + a prefix-prepending
 * adapter over the write-target shelf's vault-file surface (which speaks FULL paths — T3's
 * asymmetry), so the shelf-ignorant processors' `references/web/…` land beneath the shelf prefix.
 */
function captureStore(store: LibrarianStore, principal: Principal): ContentCaptureStore {
  const shelf = store.resolveWriteTarget(principal);
  const scoped = store.forShelf(shelf);
  const { prefix } = shelf;
  return {
    ...store,
    vaultFiles: {
      createFile: (rel, raw) => scoped.vaultFiles.createFile(prefix + rel, raw),
      writeFile: (rel, raw, options) => scoped.vaultFiles.writeFile(prefix + rel, raw, options),
    },
  };
}

function webRefs(vaultDir: string, prefix: string): string[] {
  const dir = path.join(vaultDir, prefix, "references", "web");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
}

const DATE = new Date().toISOString().slice(0, 10);

describe("/ingest references land on the write-target shelf (spec 062 SC 8b)", () => {
  it("a members/x/ write-target lands references/web under members/x/, not the vault root", async () => {
    const { store, vaultDir } = freshStore(router);
    const id = recordPending(store, {
      source: "https://coffee.example.com/lever",
      via: "extension",
    });

    const result = await processContentCapture(
      captureStore(store, SARAH),
      {
        content: "## Espresso\nThe lever machine pulls a ristretto shot under nine bars.",
        url: "https://coffee.example.com/lever",
        title: "Lever Espresso Machines",
        via: "extension",
      },
      id,
    );

    expect(result.status).toBe("success");
    // The processor's minted shelf-relative path prefixed with the shelf → lands beneath members/x/.
    expect(webRefs(vaultDir, "members/x")).toContain(`${DATE}-lever-espresso-machines.md`);
    // Nothing at the vault root, nothing on the team shelf.
    expect(fs.existsSync(path.join(vaultDir, "references"))).toBe(false);
    expect(webRefs(vaultDir, "team")).toHaveLength(0);
  });

  it("a `text` capture also lands its note beneath the write-target shelf", async () => {
    const { store, vaultDir } = freshStore(router);
    const id = recordPending(store, { source: "text-capture", via: "ios" });

    const result = await processTextCapture(
      captureStore(store, SARAH),
      { text: "Standardise on pnpm across the monorepo.", via: "ios" },
      id,
    );

    expect(result.status).toBe("success");
    expect(webRefs(vaultDir, "members/x")).toHaveLength(1);
    expect(fs.existsSync(path.join(vaultDir, "references"))).toBe(false);
  });

  it("default router: the minted path is byte-identical (references/web/ at the vault root)", async () => {
    const { store, vaultDir } = freshStore(); // default router → write-target is the vault-root shelf
    const id = recordPending(store, { source: "content-capture", via: "extension" });

    const result = await processContentCapture(
      captureStore(store, SARAH),
      { content: "# Note\n\nplain body", title: "Plain Note", via: "extension" },
      id,
    );

    expect(result.status).toBe("success");
    expect(result.path).toBe(`references/web/${DATE}-plain-note.md`);
    expect(webRefs(vaultDir, "")).toContain(`${DATE}-plain-note.md`);
  });
});
