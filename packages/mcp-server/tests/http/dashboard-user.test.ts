// spec 065 T1 / SC 11 — the assertion parser is the security boundary.
//
// `readDashboardUser` returns the FOUR-WAY DashboardAssertion. The table below pins that
// everything which is NOT positively one of the two SC 1 claim shapes is `invalid` — never
// `absent` — so the unclassified remainder can never drift toward today's isolation trust (which
// SC 9 grants only to a genuinely absent header). The shapes are CLOSED: any undeclared key makes
// the value `invalid`. Imported from the published extension entrypoint (the contract surface).

import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  DASHBOARD_USER_HEADER,
  DASHBOARD_USER_POISON,
  type DashboardAssertion,
  readDashboardUser,
} from "../../dist/extension.js";

/** base64url(UTF-8 JSON) — the exact wire encoding the dashboard setter produces. */
function enc(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** A minimal request carrying the header (or not, when `value` is undefined). */
function req(value: string | string[] | undefined): Pick<IncomingMessage, "headers"> {
  return { headers: value === undefined ? {} : { [DASHBOARD_USER_HEADER]: value } };
}

function read(value: string | string[] | undefined): DashboardAssertion {
  return readDashboardUser(req(value));
}

describe("readDashboardUser — positive shapes", () => {
  it("an absent header is `absent` (the only fail-open row — machine trust)", () => {
    expect(read(undefined)).toEqual({ kind: "absent" });
  });

  it("`{anon:true}` is the anonymous assertion", () => {
    expect(read(enc({ anon: true }))).toEqual({ kind: "anonymous" });
  });

  it("`{provider, sub}` is a user assertion, carrying just the required fields", () => {
    expect(read(enc({ provider: "github", sub: "12345" }))).toEqual({
      kind: "user",
      user: { provider: "github", sub: "12345" },
    });
  });

  it("a user assertion carries optional email + name when present", () => {
    expect(read(enc({ provider: "google", sub: "9", email: "a@b.c", name: "名前" }))).toEqual({
      kind: "user",
      user: { provider: "google", sub: "9", email: "a@b.c", name: "名前" },
    });
  });
});

describe("readDashboardUser — the invalid table (present-but-unacceptable → refuse, never absent)", () => {
  it("the poison marker is `invalid` (distinct from absent)", () => {
    expect(read(DASHBOARD_USER_POISON)).toEqual({ kind: "invalid" });
  });

  it("malformed base64url is `invalid`", () => {
    expect(read("!!! not base64url !!!")).toEqual({ kind: "invalid" });
  });

  it("a duplicated header (Node comma-joins the values) fails the base64url charset → `invalid`", () => {
    expect(read(`${enc({ anon: true })}, ${enc({ provider: "x", sub: "y" })}`)).toEqual({
      kind: "invalid",
    });
  });

  it("valid base64url of non-JSON is `invalid`", () => {
    expect(read(Buffer.from("this is not json{", "utf8").toString("base64url"))).toEqual({
      kind: "invalid",
    });
  });

  it("an oversize value (> 4 KB encoded) is `invalid`", () => {
    const huge = enc({ provider: "github", sub: "x".repeat(5000) });
    expect(huge.length).toBeGreaterThan(4096);
    expect(read(huge)).toEqual({ kind: "invalid" });
  });

  it("a non-object payload (number / string / null / array) is `invalid`", () => {
    for (const payload of [123, "a-string", null, [1, 2, 3]]) {
      expect(read(enc(payload))).toEqual({ kind: "invalid" });
    }
  });

  it("a decodable object matching NEITHER shape is `invalid`", () => {
    for (const payload of [
      {}, // empty
      { foo: 1 }, // unrelated
      { anon: false }, // anon not true
      { anon: "true" }, // anon wrong type
      { provider: "github" }, // missing sub
      { sub: "1" }, // missing provider
      { provider: 1, sub: 2 }, // wrong types
      { anon: true, provider: "x", sub: "y" }, // a mix of both shapes
    ]) {
      expect(read(enc(payload))).toEqual({ kind: "invalid" });
    }
  });

  it("an otherwise-valid user shape with ANY extra key is `invalid` (CLOSED shapes)", () => {
    expect(read(enc({ provider: "github", sub: "1", iat: 123 }))).toEqual({ kind: "invalid" });
    expect(read(enc({ provider: "github", sub: "1", email: "a@b.c", extra: true }))).toEqual({
      kind: "invalid",
    });
  });

  it("a wrong-typed optional field (email/name not a string) is `invalid`", () => {
    expect(read(enc({ provider: "github", sub: "1", email: 5 }))).toEqual({ kind: "invalid" });
    expect(read(enc({ provider: "github", sub: "1", name: {} }))).toEqual({ kind: "invalid" });
  });

  it("an array-valued header (never set by us) is `invalid`, not a throw", () => {
    expect(read([enc({ anon: true }), enc({ anon: true })])).toEqual({ kind: "invalid" });
  });
});
