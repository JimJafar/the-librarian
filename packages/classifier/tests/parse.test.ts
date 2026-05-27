// Parser tests — the last balanced `{...}` block, schema-validated,
// folds every failure mode to null. Spec §4.5.

import { describe, expect, it } from "vitest";
import { parseVerdict } from "../src/parse.js";

describe("parseVerdict", () => {
  it("parses a bare JSON object", () => {
    expect(parseVerdict('{"requires_approval": true, "is_global": false}')).toEqual({
      requires_approval: true,
      is_global: false,
    });
  });

  it("ignores a chain-of-thought preamble and reads the last object", () => {
    const text = [
      "Let me think about this. The memory mentions a person's name, so",
      "this is an identity fact and likely needs review.",
      "",
      "Actually it could just be metadata. Hmm.",
      "",
      '{"requires_approval": true, "is_global": true}',
    ].join("\n");
    expect(parseVerdict(text)).toEqual({ requires_approval: true, is_global: true });
  });

  it("when multiple JSON objects appear, the LAST balanced one wins", () => {
    const text = [
      '{"draft": "true", "is_global": false}', // earlier object, ignored
      "",
      '{"requires_approval": false, "is_global": true}',
    ].join("\n");
    expect(parseVerdict(text)).toEqual({ requires_approval: false, is_global: true });
  });

  it("ignores braces inside strings", () => {
    const text = [
      `Note that "{" is not a JSON object on its own.`,
      `{"requires_approval": false, "is_global": false}`,
    ].join("\n");
    expect(parseVerdict(text)).toEqual({ requires_approval: false, is_global: false });
  });

  it("returns null on no JSON object", () => {
    expect(parseVerdict("just prose, no braces here")).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseVerdict("{requires_approval: true is_global: false}")).toBeNull();
  });

  it("returns null when keys are missing", () => {
    expect(parseVerdict('{"requires_approval": true}')).toBeNull();
  });

  it("returns null when extra keys are present (strict schema)", () => {
    expect(
      parseVerdict('{"requires_approval": true, "is_global": false, "confidence": 0.9}'),
    ).toBeNull();
  });

  it("returns null when types are wrong", () => {
    expect(parseVerdict('{"requires_approval": "yes", "is_global": "no"}')).toBeNull();
  });

  it("returns null on an unbalanced brace (incomplete CoT mid-stream)", () => {
    expect(parseVerdict('reasoning... {"requires_approval": tru')).toBeNull();
  });
});
