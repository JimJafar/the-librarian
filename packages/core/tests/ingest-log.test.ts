import {
  listFailures,
  listRecent,
  lookupByUrl,
  markFailed,
  markSuccess,
  recordPending,
} from "@librarian/core";
import { describe, expect, it } from "vitest";

// A minimal in-memory settings store, mirroring agent-tokens.test.ts: the ingest
// log is plain JSON rows in the settings sidecar, no master key involved.
function fakeSettings() {
  const map = new Map<string, string>();
  return {
    setSetting: (key: string, value: string) => map.set(key, value),
    getSetting: (key: string) => map.get(key) ?? null,
    deleteSetting: (key: string) => map.delete(key),
    listSettings: () => [...map.keys()].map((key) => ({ key })),
  };
}

describe("ingest log — record lifecycle", () => {
  it("records a pending attempt and returns its id (D22 crash-recoverable)", () => {
    const store = fakeSettings();
    const id = recordPending(store, { source: "https://example.com/a", via: "extension" });
    expect(id.length).toBeGreaterThan(0);
    // The pending row is on disk before any background work, so a crash between
    // accept and completion still leaves a recorded attempt.
    const [row] = listRecent(store, 10);
    expect(row).toMatchObject({
      id,
      source: "https://example.com/a",
      via: "extension",
      status: "pending",
    });
    expect(row.result_path).toBeUndefined();
  });

  it("transitions a pending row to success with its result path", () => {
    const store = fakeSettings();
    const id = recordPending(store, { source: "https://example.com/a", via: "ios" });
    expect(markSuccess(store, id, "references/web/2026-06-28-a.md")).toBe(true);
    const [row] = listRecent(store, 10);
    expect(row).toMatchObject({
      status: "success",
      result_path: "references/web/2026-06-28-a.md",
    });
  });

  it("transitions a pending row to failed with a redacted error", () => {
    const store = fakeSettings();
    const id = recordPending(store, { source: "https://example.com/a", via: "android" });
    expect(markFailed(store, id, "fetch failed")).toBe(true);
    const [row] = listRecent(store, 10);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("fetch failed");
  });

  it("returns false transitioning an unknown id", () => {
    const store = fakeSettings();
    expect(markSuccess(store, "nope", "x")).toBe(false);
    expect(markFailed(store, "nope", "x")).toBe(false);
  });
});

describe("ingest log — listing", () => {
  it("lists rows newest-first, bounded by limit", () => {
    const store = fakeSettings();
    const first = recordPending(store, { source: "https://example.com/1", via: "extension" });
    // created_at uses millisecond ISO timestamps; force ordering deterministically
    // by stamping rows apart rather than relying on same-millisecond ties.
    const rowsAfterFirst = JSON.parse(store.getSetting(`ingest_log:${first}`) as string);
    rowsAfterFirst.created_at = "2026-06-28T10:00:00.000Z";
    store.setSetting(`ingest_log:${first}`, JSON.stringify(rowsAfterFirst));

    const second = recordPending(store, { source: "https://example.com/2", via: "extension" });
    const rowsAfterSecond = JSON.parse(store.getSetting(`ingest_log:${second}`) as string);
    rowsAfterSecond.created_at = "2026-06-28T11:00:00.000Z";
    store.setSetting(`ingest_log:${second}`, JSON.stringify(rowsAfterSecond));

    const recent = listRecent(store, 1);
    expect(recent).toHaveLength(1);
    expect(recent[0].source).toBe("https://example.com/2");
  });

  it("lists only failed rows in listFailures", () => {
    const store = fakeSettings();
    const ok = recordPending(store, { source: "https://example.com/ok", via: "extension" });
    markSuccess(store, ok, "references/web/ok.md");
    const bad = recordPending(store, { source: "https://example.com/bad", via: "extension" });
    markFailed(store, bad, "boom");
    recordPending(store, { source: "https://example.com/pending", via: "extension" });

    const failures = listFailures(store);
    expect(failures).toHaveLength(1);
    expect(failures[0].source).toBe("https://example.com/bad");
  });
});

describe("ingest log — dedup index (D11/D20)", () => {
  it("returns the result_path of a prior successful capture of the same URL", () => {
    const store = fakeSettings();
    const id = recordPending(store, { source: "https://example.com/article", via: "extension" });
    markSuccess(store, id, "references/web/2026-06-28-article.md");
    expect(lookupByUrl(store, "https://example.com/article")).toBe(
      "references/web/2026-06-28-article.md",
    );
  });

  it("dedups two captures that differ only by #fragment", () => {
    const store = fakeSettings();
    const id = recordPending(store, {
      source: "https://example.com/article#section-2",
      via: "extension",
    });
    markSuccess(store, id, "references/web/2026-06-28-article.md");
    expect(lookupByUrl(store, "https://example.com/article#different")).toBe(
      "references/web/2026-06-28-article.md",
    );
  });

  it("dedups a clean URL against one captured with a utm_ tracking param", () => {
    const store = fakeSettings();
    const id = recordPending(store, {
      source: "https://example.com/article?utm_source=newsletter&utm_medium=email",
      via: "ios",
    });
    markSuccess(store, id, "references/web/2026-06-28-article.md");
    expect(lookupByUrl(store, "https://example.com/article")).toBe(
      "references/web/2026-06-28-article.md",
    );
  });

  it("does NOT dedup genuinely different URLs", () => {
    const store = fakeSettings();
    const id = recordPending(store, { source: "https://example.com/article", via: "extension" });
    markSuccess(store, id, "references/web/2026-06-28-article.md");
    expect(lookupByUrl(store, "https://example.com/other")).toBeNull();
  });

  it("ignores host case and trailing slash when deduping", () => {
    const store = fakeSettings();
    const id = recordPending(store, { source: "https://Example.COM/article/", via: "extension" });
    markSuccess(store, id, "references/web/2026-06-28-article.md");
    expect(lookupByUrl(store, "https://example.com/article")).toBe(
      "references/web/2026-06-28-article.md",
    );
  });

  it("drops the other tracking params (fbclid/gclid/ref/etc) when deduping", () => {
    const store = fakeSettings();
    const id = recordPending(store, { source: "https://example.com/article", via: "extension" });
    markSuccess(store, id, "references/web/2026-06-28-article.md");
    expect(
      lookupByUrl(store, "https://example.com/article?fbclid=abc&gclid=def&ref=twitter&igshid=z"),
    ).toBe("references/web/2026-06-28-article.md");
  });

  it("does NOT satisfy a dedup lookup from a pending row (no usable path)", () => {
    const store = fakeSettings();
    recordPending(store, { source: "https://example.com/article", via: "extension" });
    expect(lookupByUrl(store, "https://example.com/article")).toBeNull();
  });

  it("does NOT satisfy a dedup lookup from a failed row", () => {
    const store = fakeSettings();
    const id = recordPending(store, { source: "https://example.com/article", via: "extension" });
    markFailed(store, id, "fetch failed");
    expect(lookupByUrl(store, "https://example.com/article")).toBeNull();
  });

  it("returns null for an unparseable lookup URL rather than throwing", () => {
    const store = fakeSettings();
    expect(lookupByUrl(store, "not a url")).toBeNull();
  });
});

describe("ingest log — secret redaction (D25)", () => {
  it("redacts credentials in the stored source before persisting", () => {
    const store = fakeSettings();
    const id = recordPending(store, {
      source: "https://user:pass@example.com/x",
      via: "extension",
    });
    const raw = store.getSetting(`ingest_log:${id}`) as string;
    // The persisted JSON must not contain the plaintext password.
    expect(raw).not.toContain("pass");
    expect(raw).toContain("[REDACTED:url-credential]");
  });

  it("redacts secrets in a stored failure error", () => {
    const store = fakeSettings();
    const id = recordPending(store, { source: "https://example.com/x", via: "extension" });
    markFailed(
      store,
      id,
      "upstream rejected: Authorization: Bearer sk-ant-superlongsecrettokenvalue1234",
    );
    const raw = store.getSetting(`ingest_log:${id}`) as string;
    expect(raw).not.toContain("sk-ant-superlongsecrettokenvalue1234");
  });
});
