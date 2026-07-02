import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { createTestMemory, readCuratorNote, readMemoryStatus, seedProposal } from "./fixtures";

// Proposal-review rework F5 — "Discuss this proposal" + consumption on confirm.
//
// D4: the chat opens grounded in the proposal (its persisted plan + resolved
// guessed target ride the system message server-side). D9: confirming a
// chat-proposed action from a proposal-grounded chat ALSO archives that
// proposal (resolution: "resolved_via_chat"); a fresh non-proposal chat
// confirm archives nothing. Chat still proposes, never executes — the
// existing chat e2e spec pins that half.

const TRPC_URL = process.env.LIBRARIAN_E2E_TRPC_URL ?? "http://127.0.0.1:3840";
const ADMIN_TOKEN = process.env.LIBRARIAN_E2E_ADMIN_TOKEN ?? "e2e-admin-token";

async function adminContext(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: TRPC_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
}

async function trpc<T>(ctx: APIRequestContext, procedure: string, input?: unknown): Promise<T> {
  const response = await ctx.post(`/trpc/${procedure}`, {
    data: (input ?? {}) as object,
    headers: { "content-type": "application/json" },
  });
  if (!response.ok()) {
    throw new Error(`tRPC ${procedure} failed: ${response.status()} ${await response.text()}`);
  }
  const body = (await response.json()) as { result?: { data?: T } };
  return body.result?.data as T;
}

// An OpenAI-compatible stub that records every prompt and returns one fixed
// completion (a JSON ChatResponse proposing an update).
function startStubLlm(completion: string): Promise<{
  url: string;
  prompts: string[];
  stop: () => Promise<void>;
}> {
  const prompts: string[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        prompts.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: completion } }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        prompts,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

test.describe("discuss this proposal (F5)", () => {
  test("chat opens grounded in the proposal; confirming consumes it; a general confirm archives nothing", async ({
    page,
  }) => {
    // The guessed target the plan points at, and the plan-carrying proposal.
    const target = await createTestMemory("Elaine", "Lives in Paris.");
    const { id: proposalId } = await seedProposal({
      title: "Elaine works at Acme",
      body: "elaine now works at acme",
      curatorNote: {
        source: "intake",
        proposed_action: "augment",
        rationale: "extends the Elaine doc",
        guessed_target_id: target.id,
        planned_addition: "Now works at [[Acme]].",
        confidence: 0.7,
      },
    });
    // A bystander proposal for the general-chat half: it must stay untouched.
    const { id: bystanderId } = await seedProposal({
      title: "Bystander proposal",
      body: "unrelated pending proposal",
      curatorNote: { source: "intake", proposed_action: "create", rationale: "r" },
    });

    const stub = await startStubLlm(
      JSON.stringify({
        kind: "proposed_action",
        action: {
          type: "update",
          id: target.id,
          patch: { body: "Lives in Paris. Works at Acme." },
        },
      }),
    );
    const ctx = await adminContext();
    let providerId = "";
    try {
      const provider = await trpc<{ id: string }>(ctx, "llm.addProvider", {
        name: "e2e-discuss-stub",
        endpoint: stub.url,
        token: "dummy-stub-token",
      });
      providerId = provider.id;
      await trpc(ctx, "llm.setConsumerConfig", {
        consumer: "chat",
        providerId: provider.id,
        model: "gpt-stub",
      });

      // ── Proposal-grounded chat: open from the card, send, confirm ─────────
      await page.goto("/proposals");
      const card = page.getByRole("article", { name: /Elaine works at Acme/ });
      await card.getByRole("button", { name: "Discuss this proposal" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();

      await dialog.getByRole("textbox", { name: /message the curator/i }).fill("apply the plan?");
      await dialog.getByRole("button", { name: "Send" }).click();
      const confirm = dialog.getByRole("button", { name: /confirm/i });
      await expect(confirm).toBeVisible();

      // D4: the persisted plan + resolved guessed target reached the model.
      const prompt = stub.prompts.join("\n");
      expect(prompt).toContain("OPEN PROPOSAL");
      expect(prompt).toContain("Now works at [[Acme]].");
      expect(prompt).toContain("Lives in Paris.");

      // Propose-never-execute still holds: nothing archived before Confirm.
      expect(await readMemoryStatus(proposalId)).toBe("proposed");

      await confirm.click();
      // Consumption is visible in the UI itself: the proposal leaves the queue,
      // which unmounts its card (and this dialog with it).
      await expect(page.getByRole("article", { name: /Elaine works at Acme/ })).not.toBeVisible();

      // The action applied AND the proposal was consumed (D9).
      expect(await readMemoryStatus(proposalId)).toBe("archived");
      expect(await readCuratorNote(proposalId)).toMatchObject({
        resolution: "resolved_via_chat",
      });

      // ── General chat confirm archives nothing (criterion 15's control) ────
      await page.goto("/curator");
      const chat = page.getByRole("region", { name: "Curator chat workspace" });
      await chat.getByRole("textbox", { name: /message the curator/i }).fill("fix Elaine again");
      await chat.getByRole("button", { name: "Send" }).click();
      const generalConfirm = chat.getByRole("button", { name: /confirm/i });
      await expect(generalConfirm).toBeVisible();
      await generalConfirm.click();
      await expect(chat.getByText(/Confirmed — the update was applied/i)).toBeVisible();

      // The bystander proposal is untouched — no proposal was in this chat's scope.
      expect(await readMemoryStatus(bystanderId)).toBe("proposed");
    } finally {
      await trpc(ctx, "memories.reject", { id: bystanderId }).catch(() => {});
      await trpc(ctx, "llm.setConsumerConfig", {
        consumer: "chat",
        providerId: "",
        model: "",
      }).catch(() => {});
      if (providerId) await trpc(ctx, "llm.deleteProvider", { id: providerId }).catch(() => {});
      await ctx.dispose();
      await stub.stop();
    }
  });
});
