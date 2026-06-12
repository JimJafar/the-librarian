import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPrimerSource,
  primerUrl,
  registerPrimerHook,
} from "../extensions/librarian/primer.js";
import { startFakeServer, type FakeServer } from "./helpers/fake-server.js";

let server: FakeServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

type HookResult = { systemPrompt?: string } | undefined | void;
type Hook = (event: BeforeAgentStartEvent, ctx: never) => Promise<HookResult>;

function capturePi(): { pi: ExtensionAPI; hook: () => Hook } {
  let captured: Hook | undefined;
  const pi = {
    on: (event: string, handler: Hook) => {
      if (event === "before_agent_start") captured = handler;
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    hook: () => {
      if (!captured) throw new Error("before_agent_start was not registered");
      return captured;
    },
  };
}

function event(systemPrompt = "BASE_SYSTEM"): BeforeAgentStartEvent {
  return {
    type: "before_agent_start",
    prompt: "hello",
    systemPrompt,
    systemPromptOptions: {} as BeforeAgentStartEvent["systemPromptOptions"],
  };
}

describe("primerUrl", () => {
  it("resolves /primer.md at the server ROOT, stripping the /mcp path", () => {
    expect(primerUrl("https://librarian.example/mcp")).toBe("https://librarian.example/primer.md");
    expect(primerUrl("http://127.0.0.1:8787/mcp")).toBe("http://127.0.0.1:8787/primer.md");
  });

  it("returns null for an unparseable endpoint", () => {
    expect(primerUrl("not a url")).toBeNull();
  });
});

describe("createPrimerSource", () => {
  it("fetches the primer from GET /primer.md without an Authorization header", async () => {
    server = await startFakeServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end("# Librarian primer\nRecall before answering.");
    });
    const getPrimer = createPrimerSource({ endpoint: `${server.url}/mcp` });

    const primer = await getPrimer();

    expect(primer).toBe("# Librarian primer\nRecall before answering.");
    const request = server.requests[0]!;
    expect(request.method).toBe("GET");
    expect(request.path).toBe("/primer.md");
    expect(request.headers.authorization).toBeUndefined();
  });

  it("caches the primer per process — one HTTP fetch across turns", async () => {
    server = await startFakeServer((_req, res) => {
      res.writeHead(200);
      res.end("PRIMER");
    });
    const getPrimer = createPrimerSource({ endpoint: `${server.url}/mcp` });

    expect(await getPrimer()).toBe("PRIMER");
    expect(await getPrimer()).toBe("PRIMER");
    expect(await getPrimer()).toBe("PRIMER");
    expect(server.requests).toHaveLength(1);
  });

  it("fails soft to empty when the server is down, and retries (no negative cache)", async () => {
    const probe = await startFakeServer((_req, res) => res.end());
    const endpoint = `${probe.url}/mcp`;
    await probe.close();

    let calls = 0;
    // The injected fetch never dials the (closed) endpoint — it scripts
    // "down on turn 1, healthy from turn 2".
    const fetchImpl: typeof fetch = async (..._args) => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return new Response("PRIMER", { status: 200 });
    };
    const getPrimer = createPrimerSource({ endpoint, fetchImpl });

    expect(await getPrimer()).toBe(""); // failure → empty, not cached
    expect(await getPrimer()).toBe("PRIMER"); // next turn retries and succeeds
    expect(await getPrimer()).toBe("PRIMER"); // …and is now cached
    expect(calls).toBe(2);
  });

  it("fails soft to empty on a non-200", async () => {
    server = await startFakeServer((_req, res) => {
      res.writeHead(404);
      res.end("Not found");
    });
    const getPrimer = createPrimerSource({ endpoint: `${server.url}/mcp` });
    expect(await getPrimer()).toBe("");
  });

  it("fails soft to empty when the body exceeds the size cap", async () => {
    server = await startFakeServer((_req, res) => {
      res.writeHead(200);
      res.end("p".repeat(2048));
    });
    const getPrimer = createPrimerSource({ endpoint: `${server.url}/mcp`, maxBytes: 1024 });
    expect(await getPrimer()).toBe("");
  });
});

describe("registerPrimerHook", () => {
  it("appends the primer to the system prompt as original + blank line + primer", async () => {
    const { pi, hook } = capturePi();
    registerPrimerHook(pi, async () => "PRIMER_TEXT");

    const out = await hook()(event("BASE_SYSTEM"), {} as never);

    expect(out).toEqual({ systemPrompt: "BASE_SYSTEM\n\nPRIMER_TEXT" });
  });

  it("leaves the prompt untouched when the primer is empty", async () => {
    const { pi, hook } = capturePi();
    registerPrimerHook(pi, async () => "");

    const out = await hook()(event(), {} as never);
    expect(out).toBeUndefined();
  });

  it("leaves the prompt untouched when the primer is whitespace-only", async () => {
    const { pi, hook } = capturePi();
    registerPrimerHook(pi, async () => "  \n  ");

    const out = await hook()(event(), {} as never);
    expect(out).toBeUndefined();
  });

  it("fails soft when the primer source throws — the turn is never blocked", async () => {
    const { pi, hook } = capturePi();
    registerPrimerHook(pi, async () => {
      throw new Error("boom");
    });

    const out = await hook()(event(), {} as never);
    expect(out).toBeUndefined();
  });
});
