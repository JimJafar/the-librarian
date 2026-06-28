import { afterEach, describe, expect, it, vi } from "vitest";
import { mapResponse, sendCapture } from "../src/lib/send.js";
import type { CaptureConfig, IngestPayload } from "../src/lib/types.js";

const payload: IngestPayload = {
  url: "https://example.com/article",
  title: "A Title",
  content: "# A Title\n\nbody",
  via: "extension",
};

const config: CaptureConfig = {
  serverUrl: "https://librarian.example.com",
  token: "lib_capture_secret_value",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mapResponse", () => {
  it("maps each documented status to the right user-facing kind", () => {
    expect(mapResponse(202, "id-1")).toMatchObject({ ok: true, kind: "queued", id: "id-1" });
    expect(mapResponse(400, undefined).kind).toBe("bad-request");
    expect(mapResponse(401, undefined).kind).toBe("unauthorized");
    expect(mapResponse(403, undefined).kind).toBe("forbidden");
    expect(mapResponse(413, undefined).kind).toBe("too-large");
    expect(mapResponse(429, undefined).kind).toBe("rate-limited");
    expect(mapResponse(500, undefined).kind).toBe("server-error");
  });

  it("only the 202 is ok", () => {
    for (const status of [400, 401, 403, 413, 429, 500, 503]) {
      expect(mapResponse(status, undefined).ok).toBe(false);
    }
    expect(mapResponse(202, undefined).ok).toBe(true);
  });
});

describe("sendCapture", () => {
  it("POSTs to /ingest with the Bearer header and returns queued on 202", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(202, { status: "queued", id: "log-42" }));

    const result = await sendCapture(payload, config, fetchImpl as unknown as typeof fetch);

    expect(result).toMatchObject({ ok: true, kind: "queued", id: "log-42" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe("https://librarian.example.com/ingest");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer lib_capture_secret_value",
    );
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  it("never puts the token in the URL", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(202, { status: "queued", id: "x" }));
    await sendCapture(payload, config, fetchImpl as unknown as typeof fetch);
    const [calledUrl] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).not.toContain(config.token);
  });

  it("never logs the capture token", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect failed to https://librarian.example.com with ${config.token}`);
    });

    await sendCapture(payload, config, fetchImpl as unknown as typeof fetch);

    for (const spy of [logSpy, errorSpy, warnSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(config.token);
      }
    }
  });

  it("maps 401/403/413/429 to teaching statuses", async () => {
    const cases: Array<[number, string]> = [
      [401, "unauthorized"],
      [403, "forbidden"],
      [413, "too-large"],
      [429, "rate-limited"],
    ];
    for (const [status, kind] of cases) {
      const fetchImpl = vi.fn(async () => jsonResponse(status, { error: "nope" }));
      const result = await sendCapture(payload, config, fetchImpl as unknown as typeof fetch);
      expect(result.kind).toBe(kind);
      expect(result.ok).toBe(false);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("maps a thrown fetch (network/mixed-content/blocked redirect) to network-error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const result = await sendCapture(payload, config, fetchImpl as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: false, kind: "network-error" });
    expect(result.message).not.toContain(config.token);
  });

  it("returns not-configured without calling fetch when the token is missing", async () => {
    const fetchImpl = vi.fn();
    const result = await sendCapture(
      payload,
      { serverUrl: "https://example.com", token: "  " },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.kind).toBe("not-configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns not-configured for an invalid server URL without calling fetch", async () => {
    const fetchImpl = vi.fn();
    const result = await sendCapture(
      payload,
      { serverUrl: "not a url", token: "lib_capture_x" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.kind).toBe("not-configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
