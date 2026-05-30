import { createGithubTarget, resolveGithubSyncConfig } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REPO = "owner/backups";
const TOKEN = "ghp_secret_token_value_do_not_leak";

// A small stateful GitHub fake: Releases keyed by tag, each with named assets, plus
// the set of tag refs. Enough of the REST surface for the target's put/get/list/
// deleteBundle to round-trip without a network.
function makeFakeGithub() {
  let nextId = 1;
  const releases = new Map<
    string,
    { id: number; tag_name: string; assets: Map<string, { id: number; data: Buffer }> }
  >();
  const tags = new Set<string>();
  const apiRepo = `https://api.github.com/repos/${REPO}`;
  const uploadsRepo = `https://uploads.github.com/repos/${REPO}`;

  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const serialize = (r: { id: number; tag_name: string; assets: Map<string, { id: number }> }) => ({
    id: r.id,
    tag_name: r.tag_name,
    assets: [...r.assets].map(([name, a]) => ({ id: a.id, name })),
  });

  async function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (url.startsWith("https://api.github.com") && headers.authorization !== `Bearer ${TOKEN}`) {
      return json(401, { message: "Bad credentials" });
    }

    let m: RegExpMatchArray | null;
    if (method === "GET" && (m = url.match(new RegExp(`^${esc(apiRepo)}/releases/tags/(.+)$`)))) {
      const rel = releases.get(decodeURIComponent(m[1]));
      return rel ? json(200, serialize(rel)) : json(404, { message: "Not Found" });
    }
    if (method === "POST" && url === `${apiRepo}/releases`) {
      const body = JSON.parse(String(init.body));
      const rel = { id: nextId++, tag_name: body.tag_name as string, assets: new Map() };
      releases.set(rel.tag_name, rel);
      tags.add(rel.tag_name);
      return json(201, serialize(rel));
    }
    if (
      method === "POST" &&
      (m = url.match(new RegExp(`^${esc(uploadsRepo)}/releases/(\\d+)/assets\\?name=(.+)$`)))
    ) {
      const rel = [...releases.values()].find((r) => r.id === Number(m![1]));
      if (!rel) return json(404, { message: "Not Found" });
      const name = decodeURIComponent(m[2]);
      rel.assets.set(name, { id: nextId++, data: Buffer.from(init.body as Uint8Array) });
      return json(201, { id: nextId, name });
    }
    if (
      method === "DELETE" &&
      (m = url.match(new RegExp(`^${esc(apiRepo)}/releases/assets/(\\d+)$`)))
    ) {
      for (const rel of releases.values())
        for (const [name, a] of rel.assets) if (a.id === Number(m![1])) rel.assets.delete(name);
      return new Response(null, { status: 204 });
    }
    if (
      method === "GET" &&
      (m = url.match(new RegExp(`^${esc(apiRepo)}/releases/assets/(\\d+)$`)))
    ) {
      for (const rel of releases.values())
        for (const a of rel.assets.values())
          if (a.id === Number(m![1])) return new Response(a.data, { status: 200 });
      return json(404, { message: "Not Found" });
    }
    if (method === "GET" && url.startsWith(`${apiRepo}/releases?`)) {
      return json(200, [...releases.values()].map(serialize));
    }
    if (method === "DELETE" && (m = url.match(new RegExp(`^${esc(apiRepo)}/releases/(\\d+)$`)))) {
      for (const [tag, rel] of releases) if (rel.id === Number(m![1])) releases.delete(tag);
      return new Response(null, { status: 204 });
    }
    if (
      method === "DELETE" &&
      (m = url.match(new RegExp(`^${esc(apiRepo)}/git/refs/tags/(.+)$`)))
    ) {
      const tag = decodeURIComponent(m[1]);
      if (!tags.has(tag)) return json(404, { message: "Not Found" });
      tags.delete(tag);
      return new Response(null, { status: 204 });
    }
    return json(404, { message: `unhandled ${method} ${url}` });
  }

  return { fakeFetch, releases, tags, json };
}

describe("createGithubTarget (Releases)", () => {
  let fake: ReturnType<typeof makeFakeGithub>;

  beforeEach(() => {
    fake = makeFakeGithub();
    vi.stubGlobal("fetch", fake.fakeFetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  const target = () => createGithubTarget({ repo: REPO, token: TOKEN });

  it("put creates a release with the file attached, and get returns the bytes", async () => {
    const t = target();
    await t.put("librarian-backup-A/events.jsonl", Buffer.from("hello"));
    expect(fake.releases.has("librarian-backup-A")).toBe(true);
    expect((await t.get("librarian-backup-A/events.jsonl")).toString()).toBe("hello");
  });

  it("put overwrites an existing asset", async () => {
    const t = target();
    await t.put("librarian-backup-A/f", Buffer.from("one"));
    await t.put("librarian-backup-A/f", Buffer.from("two"));
    expect((await t.get("librarian-backup-A/f")).toString()).toBe("two");
    expect(fake.releases.get("librarian-backup-A")!.assets.size).toBe(1);
  });

  it("list returns <bundle>/<file> keys for backup releases only", async () => {
    const t = target();
    await t.put("librarian-backup-A/librarian.sqlite.gz", Buffer.from("x"));
    await t.put("librarian-backup-B/events.jsonl.gz", Buffer.from("y"));
    // A non-backup release must be ignored.
    fake.releases.set("v1.0.0", {
      id: 999,
      tag_name: "v1.0.0",
      assets: new Map([["app.zip", { id: 998, data: Buffer.from("z") }]]),
    });

    expect(await t.list()).toEqual([
      "librarian-backup-A/librarian.sqlite.gz",
      "librarian-backup-B/events.jsonl.gz",
    ]);
    expect(await t.list("librarian-backup-B/")).toEqual(["librarian-backup-B/events.jsonl.gz"]);
  });

  it("deleteBundle removes the release AND its tag (no orphan tag)", async () => {
    const t = target();
    await t.put("librarian-backup-A/f", Buffer.from("x"));
    expect(fake.tags.has("librarian-backup-A")).toBe(true);

    await t.deleteBundle("librarian-backup-A");
    expect(fake.releases.has("librarian-backup-A")).toBe(false);
    expect(fake.tags.has("librarian-backup-A")).toBe(false);
    expect(await t.list()).toEqual([]);
    await t.deleteBundle("librarian-backup-A"); // idempotent
  });

  it("never leaks the token in an error message", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ message: "forbidden" }), { status: 403 }),
    );
    const t = target();
    const err = await t.put("librarian-backup-A/f", Buffer.from("x")).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain("403");
  });

  it("rejects a malformed repo", () => {
    expect(() => createGithubTarget({ repo: "no-slash", token: TOKEN })).toThrow(/owner\/repo/);
  });
});

describe("resolveGithubSyncConfig", () => {
  const noSettings = { getSetting: () => null };

  it("returns null when not configured", () => {
    expect(resolveGithubSyncConfig(noSettings, {})).toBeNull();
  });

  it("resolves from env", () => {
    expect(
      resolveGithubSyncConfig(noSettings, {
        LIBRARIAN_BACKUP_GITHUB_REPO: "o/r",
        LIBRARIAN_BACKUP_GITHUB_TOKEN: "tok",
      }),
    ).toEqual({ repo: "o/r", token: "tok" });
  });

  it("prefers settings over env and tolerates a secret read that throws", () => {
    const store = {
      getSetting: (key: string) => {
        if (key === "backup.github.token") throw new Error("no master key");
        if (key === "backup.github.repo") return "from/settings";
        return null;
      },
    };
    const config = resolveGithubSyncConfig(store, {
      LIBRARIAN_BACKUP_GITHUB_REPO: "from/env",
      LIBRARIAN_BACKUP_GITHUB_TOKEN: "env-token", // settings read threw → env used
    });
    expect(config).toEqual({ repo: "from/settings", token: "env-token" });
  });
});
