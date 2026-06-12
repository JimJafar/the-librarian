import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { createTestMemory } from "./fixtures";

// Spec 044 D-7 — the dashboard curator chat UI + entry points + lifecycle controls.
//
// This runs against the shared e2e mcp-server (auth off). The chat turn needs a
// deterministic LLM, so the proposed-action test starts a LOCAL OpenAI-compatible
// stub, configures the curator chat/grooming provider to point at it (the server
// encrypts the token with its own master key, so it round-trips within this run),
// and scripts the completion. The entry-point + lifecycle tests need no LLM (the
// lifecycle is driven over real addendum tRPC; entry points just open the panel).
//
// LOAD-BEARING: a proposed_action is PROPOSED, never auto-run — the test asserts
// the memory is unchanged until the admin clicks Confirm, then changed after.

const SERVER_URL = process.env.LIBRARIAN_E2E_SERVER_URL ?? "http://127.0.0.1:3838";
const ADMIN_TOKEN = process.env.LIBRARIAN_E2E_ADMIN_TOKEN ?? "e2e-admin-token";

async function adminContext(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: SERVER_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
}

async function trpc<T>(ctx: APIRequestContext, procedure: string, input: unknown): Promise<T> {
  const response = await ctx.post(`/trpc/${procedure}`, {
    data: input as object,
    headers: { "content-type": "application/json" },
  });
  if (!response.ok()) {
    throw new Error(`tRPC ${procedure} failed: ${response.status()} ${await response.text()}`);
  }
  const body = (await response.json()) as { result?: { data?: T } };
  return body.result?.data as T;
}

// tRPC QUERY procedures (memories.list / addendum.get) must use GET with the
// input in the `input` query param.
async function trpcQuery<T>(ctx: APIRequestContext, procedure: string, input: unknown): Promise<T> {
  const response = await ctx.get(`/trpc/${procedure}`, {
    params: { input: JSON.stringify(input) },
  });
  if (!response.ok()) {
    throw new Error(`tRPC ${procedure} failed: ${response.status()} ${await response.text()}`);
  }
  const body = (await response.json()) as { result?: { data?: T } };
  return body.result?.data as T;
}

// A minimal OpenAI-compatible chat-completions stub the curator chat client talks
// to. Returns a single fixed completion (a JSON ChatResponse) for every request.
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
    // 0.0.0.0 so the in-process mcp-server (on 127.0.0.1) can reach it.
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

test.describe("curator chat — entry points", () => {
  test("the general fresh-chat entry on the curator page opens the chat + job picker", async ({
    page,
  }) => {
    await page.goto("/curator");
    const chat = page.getByRole("region", { name: "Curator chat workspace" });
    await expect(chat).toBeVisible();
    // The job picker (intake / grooming) is present.
    await expect(chat.getByRole("combobox", { name: "Curator job" })).toBeVisible();
    // The split-screen chat panel + addendum draft editor are present.
    await expect(chat.getByRole("textbox", { name: /message the curator/i })).toBeVisible();
    await expect(chat.getByRole("textbox", { name: /addendum draft/i })).toBeVisible();
  });

  test("'Discuss this memory' on a memory opens the chat pre-populated with the memory", async ({
    page,
  }) => {
    const { id } = await createTestMemory("Chat entry memory", "discuss me");
    await page.goto("/");
    await page.getByRole("button", { name: /Chat entry memory/ }).click();
    await page.getByRole("button", { name: "Discuss this memory" }).click();
    // The chat dialog opens grounded in the memory id.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(id)).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: /message the curator/i })).toBeVisible();
  });
});

test.describe("curator chat — proposed action (propose, confirm, never auto-run)", () => {
  test("a proposed update is NOT applied until the admin confirms, then it applies", async ({
    page,
  }) => {
    const { id } = await createTestMemory("Original title", "body to keep");

    // Script the chat to propose an `update` action against this memory.
    const stub = await startStubLlm(
      JSON.stringify({
        kind: "proposed_action",
        action: { type: "update", id, patch: { title: "Curator-fixed title" } },
      }),
    );
    const ctx = await adminContext();
    let providerId = "";
    try {
      // Point the chat consumer at the stub via a named provider (grooming fallback
      // would also work; we set chat directly).
      const provider = await trpc<{ id: string }>(ctx, "llm.addProvider", {
        name: "e2e-chat-stub",
        endpoint: stub.url,
        token: "dummy-stub-token",
      });
      providerId = provider.id;
      await trpc(ctx, "llm.setConsumerConfig", {
        consumer: "chat",
        providerId: provider.id,
        model: "gpt-stub",
      });

      await page.goto("/curator");
      const chat = page.getByRole("region", { name: "Curator chat workspace" });
      await chat.getByRole("textbox", { name: /message the curator/i }).fill("fix the title");
      await chat.getByRole("button", { name: "Send" }).click();

      // The proposed action is shown for confirmation — NOT auto-applied.
      const confirm = chat.getByRole("button", { name: /confirm/i });
      await expect(confirm).toBeVisible();

      // The memory is still its original title (nothing ran yet — propose, not run).
      const before = await trpcQuery<{ memories: { id: string; title: string }[] }>(
        ctx,
        "memories.list",
        { status: "active", limit: 200 },
      );
      expect(before.memories.find((m) => m.id === id)?.title).toBe("Original title");

      // Now confirm — the update runs.
      await confirm.click();
      await expect(chat.getByText(/Confirmed — the update was applied/i)).toBeVisible();

      const after = await trpcQuery<{ memories: { id: string; title: string }[] }>(
        ctx,
        "memories.list",
        { status: "active", limit: 200 },
      );
      expect(after.memories.find((m) => m.id === id)?.title).toBe("Curator-fixed title");
    } finally {
      // Clean up: clear the chat consumer config + delete the stub provider so
      // other specs see no leftover provider (the suite shares one store).
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

test.describe("curator chat — addendum roll-back (rethink D4: git is the rollback)", () => {
  test("a committed grooming addendum can be rolled back from the dashboard", async ({ page }) => {
    const ctx = await adminContext();
    try {
      // Seed two committed versions; edits apply immediately (no evaluation state).
      await trpc(ctx, "addendum.set", { job: "grooming", content: "rollback v1" });
      await trpc(ctx, "addendum.set", { job: "grooming", content: "rollback v2 (bad)" });
      let state = await trpcQuery<{ content: string }>(ctx, "addendum.get", { job: "grooming" });
      expect(state.content).toBe("rollback v2 (bad)");

      await page.goto("/curator");
      const chat = page.getByRole("region", { name: "Curator chat workspace" });
      await chat.getByRole("button", { name: "Roll back addendum" }).click();
      await expect(chat.getByText(/Rolled back — the prior grooming addendum/i)).toBeVisible();

      state = await trpcQuery<{ content: string }>(ctx, "addendum.get", { job: "grooming" });
      expect(state.content).toBe("rollback v1");
    } finally {
      await ctx.dispose();
    }
  });
});
