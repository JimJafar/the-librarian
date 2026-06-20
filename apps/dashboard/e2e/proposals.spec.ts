// E2E for the proposal review queue (spec 2026-06-20 proposal-review-ux, T4).
//
// Seeds PROPOSED memories with self-describing curator_note provenance straight
// into the e2e store (the admin tRPC create always auto-applies; a proposal
// needs the trusted options channel — see fixtures.seedProposal), then drives
// the /proposals page:
//   - a replace shows the old memory, the new, and a DiffView; approving it
//     leaves exactly one active memory for the fact (the old source archived);
//   - a merge approval archives ALL its sources;
//   - a create shows no diff and approving it archives nothing.
//
// Runs against the shared e2e mcp-server (auth enforcement OFF — global-setup
// configures auth but never enables it, so the dashboard renders without a
// session). The /proposals page is force-dynamic, so each goto re-reads the
// freshly-seeded proposals from disk.

import { expect, test } from "@playwright/test";
import { createTestMemory, readMemoryStatus, seedProposal } from "./fixtures";

test.describe("proposal review queue", () => {
  test("a replace shows old + new + diff and approving it archives the source", async ({
    page,
  }) => {
    const stamp = Date.now();
    const fact = `e2e-replace-${stamp}`;
    // The active memory the replacement supersedes.
    const { id: sourceId } = await createTestMemory(fact, "Espresso, no sugar.");
    // The proposed replacement: a grooming update carrying the target id.
    const proposalTitle = `${fact}-new`;
    await seedProposal({
      title: proposalTitle,
      body: "Espresso, one sugar.",
      curatorNote: {
        source: "grooming",
        proposed_action: "update",
        rationale: "Corrected the sugar preference",
        supersedes: [sourceId],
      },
    });

    await page.goto("/proposals");
    await expect(page.getByRole("heading", { name: "Proposals", level: 1 })).toBeVisible();

    const card = page.getByRole("article", { name: new RegExp(proposalTitle) });
    await expect(card).toBeVisible({ timeout: 15_000 });
    // Authoritative Update badge (a target resolved), source chip, rationale.
    await expect(card.getByText("Update", { exact: true })).toBeVisible();
    await expect(card.getByText("grooming", { exact: true })).toBeVisible();
    await expect(card.getByText(/Corrected the sugar preference/)).toBeVisible();
    // Old body (the panel <p>, exact — the diff's deletion line also contains
    // this text prefixed with "-"), and the diff itself.
    await expect(card.getByText("Espresso, no sugar.", { exact: true })).toBeVisible();
    await expect(card.getByLabel("Unified diff")).toBeVisible();

    // Approve states the archival consequence, then archives the source.
    const approve = card.getByRole("button", { name: "Approve — replaces 1 memory" });
    await expect(approve).toBeVisible();
    await approve.click();

    // The source is archived; exactly one active memory remains for the fact.
    await expect.poll(() => readMemoryStatus(sourceId), { timeout: 15_000 }).toBe("archived");
  });

  test("a merge approval archives every source", async ({ page }) => {
    const stamp = Date.now();
    const tag = `e2e-merge-${stamp}`;
    const { id: aId } = await createTestMemory(`${tag}-a`, "same fact, phrasing A");
    const { id: bId } = await createTestMemory(`${tag}-b`, "same fact, phrasing B");
    const proposalTitle = `${tag}-merged`;
    await seedProposal({
      title: proposalTitle,
      body: "the merged fact",
      curatorNote: {
        source: "grooming",
        proposed_action: "merge",
        rationale: "Collapsed two duplicates",
        supersedes: [aId, bId],
      },
    });

    await page.goto("/proposals");
    const card = page.getByRole("article", { name: new RegExp(proposalTitle) });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText("Merge", { exact: true })).toBeVisible();
    // Both sources listed, and NO line diff for a merge.
    await expect(card.getByText("same fact, phrasing A")).toBeVisible();
    await expect(card.getByText("same fact, phrasing B")).toBeVisible();
    await expect(card.getByLabel("Unified diff")).toHaveCount(0);

    await card.getByRole("button", { name: "Approve — merges 2 memories" }).click();

    await expect.poll(() => readMemoryStatus(aId), { timeout: 15_000 }).toBe("archived");
    await expect.poll(() => readMemoryStatus(bId), { timeout: 15_000 }).toBe("archived");
  });

  test("a create shows no diff and approving it archives nothing", async ({ page }) => {
    const stamp = Date.now();
    const proposalTitle = `e2e-create-${stamp}`;
    const { id: proposalId } = await seedProposal({
      title: proposalTitle,
      body: "A brand new fact worth keeping.",
      curatorNote: {
        source: "intake",
        proposed_action: "create",
        rationale: "A new fact worth keeping",
      },
    });

    await page.goto("/proposals");
    const card = page.getByRole("article", { name: new RegExp(proposalTitle) });
    await expect(card).toBeVisible({ timeout: 15_000 });
    // Target-less intake create is badged honestly, with no diff.
    await expect(card.getByText("New — needs filing")).toBeVisible();
    await expect(card.getByLabel("Unified diff")).toHaveCount(0);

    // Plain Approve (nothing archived); the proposal activates unchanged.
    await card.getByRole("button", { name: "Approve", exact: true }).click();
    await expect.poll(() => readMemoryStatus(proposalId), { timeout: 15_000 }).toBe("active");
  });
});
