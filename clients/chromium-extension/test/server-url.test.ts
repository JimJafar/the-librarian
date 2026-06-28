import { describe, expect, it } from "vitest";
import { isInsecureServer, parseServerUrl } from "../src/lib/server-url.js";

describe("parseServerUrl", () => {
  it("normalizes an https URL to an origin, ingest endpoint, and match pattern", () => {
    const parsed = parseServerUrl("https://librarian.example.com");
    expect(parsed.origin).toBe("https://librarian.example.com");
    expect(parsed.ingestUrl).toBe("https://librarian.example.com/ingest");
    expect(parsed.originPattern).toBe("https://librarian.example.com/*");
    expect(parsed.insecure).toBe(false);
    expect(parsed.loopback).toBe(false);
  });

  it("strips a trailing slash and any path from the entered URL", () => {
    expect(parseServerUrl("https://example.com/").ingestUrl).toBe("https://example.com/ingest");
    expect(parseServerUrl("https://example.com/some/path").ingestUrl).toBe(
      "https://example.com/ingest",
    );
  });

  it("preserves a non-default port", () => {
    const parsed = parseServerUrl("http://192.168.1.10:8080");
    expect(parsed.origin).toBe("http://192.168.1.10:8080");
    expect(parsed.ingestUrl).toBe("http://192.168.1.10:8080/ingest");
    expect(parsed.originPattern).toBe("http://192.168.1.10:8080/*");
  });

  it("flags http as insecure and https as secure", () => {
    expect(parseServerUrl("http://example.com").insecure).toBe(true);
    expect(parseServerUrl("https://example.com").insecure).toBe(false);
  });

  it("recognizes loopback/localhost targets", () => {
    expect(parseServerUrl("http://localhost:3000").loopback).toBe(true);
    expect(parseServerUrl("http://127.0.0.1:3000").loopback).toBe(true);
    expect(parseServerUrl("http://example.com").loopback).toBe(false);
  });

  it("throws a teaching error for empty input", () => {
    expect(() => parseServerUrl("   ")).toThrow(/server URL/i);
  });

  it("throws a teaching error for a schemeless or unparseable URL", () => {
    expect(() => parseServerUrl("example.com")).toThrow(/scheme/i);
    expect(() => parseServerUrl("ht!tp://nope")).toThrow();
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => parseServerUrl("ftp://example.com")).toThrow(/http/i);
  });
});

describe("isInsecureServer", () => {
  it("is true for http and false for https", () => {
    expect(isInsecureServer("http://192.168.1.10:8080")).toBe(true);
    expect(isInsecureServer("https://example.com")).toBe(false);
  });

  it("is false (not a warning) for unparseable input — the parse error is the message", () => {
    expect(isInsecureServer("")).toBe(false);
    expect(isInsecureServer("not a url")).toBe(false);
  });
});
