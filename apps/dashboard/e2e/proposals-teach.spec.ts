import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { readMemoryStatus, seedProposal } from "./fixtures";

// Proposal-review rework F4 — the "Reject & make an example" teach flow.
//
// Scenario C ordering end-to-end: note → distill (stub LLM returns the updated
// whole examples document) → diff preview → confirm commits the document THEN
// rejects the proposal. Cancel is a no-op. The entry point is intake-only in
// v1 (scenario F) — grooming-sourced cards don't offer it.
//
// Runs against the shared e2e mcp-server; the distill turn needs a
// deterministic LLM, so the teach tests start a LOCAL OpenAI-compatible stub
// and point the `chat` consumer at it (same pattern as curator-chat.spec.ts).

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

async function trpcQuery<T>(ctx: APIRequestContext, procedure: string): Promise<T> {
  const response = await ctx.get(`/trpc/${procedure}`);
  if (!response.ok()) {
    throw new Error(`tRPC ${procedure} failed: ${response.status()} ${await response.text()}`);
  }
  const body = (await response.json()) as { result?: { data?: T } };
  return body.result?.data as T;
}

// A minimal OpenAI-compatible stub returning one fixed completion — the
// distilled whole document.
function startStubLlm(completion: string): Promise<{ url: string; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: completion } }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

test.describe("reject & make an example (F4)", () => {
  test("confirm commits the examples doc and archives the proposal, in that order", async ({
    page,
  }) => {
    const DISTILLED = "- One-off task reminders: not memory-worthy.";
    const { id } = await seedProposal({
      title: "Teach flow victim",
      body: "TODO: fix the flaky auth test tomorrow.",
      curatorNote: { source: "intake", proposed_action: "create", rationale: "low value" },
    });
    const stub = await startStubLlm(DISTILLED);
    const ctx = await adminContext();
    let providerId = "";
    try {
      const provider = await trpc<{ id: string }>(ctx, "llm.addProvider", {
        name: "e2e-teach-stub",
        endpoint: stub.url,
        token: "dummy-stub-token",
      });
      providerId = provider.id;
      await trpc(ctx, "llm.setConsumerConfig", {
        consumer: "chat",
        providerId: provider.id,
        model: "gpt-stub",
      });

      await page.goto("/proposals");
      const card = page.getByRole("article", { name: /Teach flow victim/ });
      await card.getByRole("button", { name: "Reject & make an example" }).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("textbox", { name: /note/i }).fill("one-off task noise");
      await dialog.getByRole("button", { name: /Distill/ }).click();

      // The diff preview shows the added entry; nothing committed yet.
      await expect(dialog.getByLabel("Unified diff")).toBeVisible();
      const before = await trpcQuery<{ content: string }>(ctx, "examples.get");
      expect(before.content).not.toContain("One-off task reminders");
      expect(await readMemoryStatus(id)).toBe("proposed");

      await dialog.getByRole("button", { name: /Teach & reject/ }).click();
      await expect(dialog).not.toBeVisible();

      // Doc committed AND proposal archived.
      const after = await trpcQuery<{ content: string }>(ctx, "examples.get");
      expect(after.content).toBe(DISTILLED);
      expect(await readMemoryStatus(id)).toBe("archived");
    } finally {
      await trpc(ctx, "examples.set", { content: "" }).catch(() => {});
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

  test("cancel after the preview changes nothing", async ({ page }) => {
    const { id } = await seedProposal({
      title: "Teach cancel victim",
      body: "another low-value submission",
      curatorNote: { source: "intake", proposed_action: "create", rationale: "low value" },
    });
    const stub = await startStubLlm("- would-be entry.");
    const ctx = await adminContext();
    let providerId = "";
    try {
      const provider = await trpc<{ id: string }>(ctx, "llm.addProvider", {
        name: "e2e-teach-cancel-stub",
        endpoint: stub.url,
        token: "dummy-stub-token",
      });
      providerId = provider.id;
      await trpc(ctx, "llm.setConsumerConfig", {
        consumer: "chat",
        providerId: provider.id,
        model: "gpt-stub",
      });

      await page.goto("/proposals");
      const card = page.getByRole("article", { name: /Teach cancel victim/ });
      await card.getByRole("button", { name: "Reject & make an example" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: /Distill/ }).click();
      await expect(dialog.getByLabel("Unified diff")).toBeVisible();

      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).not.toBeVisible();

      // Nothing changed: doc untouched, proposal still open — and plain Reject
      // still works (fail-soft: teaching never blocks rejection).
      const doc = await trpcQuery<{ content: string }>(ctx, "examples.get");
      expect(doc.content).not.toContain("would-be entry");
      expect(await readMemoryStatus(id)).toBe("proposed");

      await card.getByRole("button", { name: "Reject", exact: true }).click();
      await expect(page.getByRole("article", { name: /Teach cancel victim/ })).not.toBeVisible();
      expect(await readMemoryStatus(id)).toBe("archived");
    } finally {
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

  test("a grooming-sourced proposal offers no teach entry point (v1 scope)", async ({ page }) => {
    const { id } = await seedProposal({
      title: "Grooming sourced proposal",
      body: "a grooming replacement",
      curatorNote: { source: "grooming", proposed_action: "create", rationale: "corpus fix" },
    });
    try {
      await page.goto("/proposals");
      const card = page.getByRole("article", { name: /Grooming sourced proposal/ });
      await expect(card).toBeVisible();
      await expect(
        card.getByRole("button", { name: "Reject & make an example" }),
      ).not.toBeVisible();
    } finally {
      // Clean up: reject the seeded proposal so later specs see a clean queue.
      const ctx = await adminContext();
      await trpc(ctx, "memories.reject", { id }).catch(() => {});
      await ctx.dispose();
    }
  });
});
