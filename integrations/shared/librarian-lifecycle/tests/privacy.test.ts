import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRIVATE_MARKERS,
  DEFAULT_PUBLIC_MARKERS,
  detectPrivacySignal,
} from "../src/privacy.js";

describe("detectPrivacySignal — enter-private markers (§3.3)", () => {
  it("catches each explicit private phrase on its own", () => {
    for (const marker of DEFAULT_PRIVATE_MARKERS) {
      const d = detectPrivacySignal(marker);
      expect(d.signal, marker).toBe("enter-private");
      expect(d.matched, marker).toBe(marker);
    }
  });

  it("treats a private marker mixed with substantive content as fully private", () => {
    const d = detectPrivacySignal("off the record, my api key is abc123 — what do you think?");
    expect(d.signal).toBe("enter-private");
    expect(d.hasSubstantiveContent).toBe(true);
  });

  it("flags a bare marker as having no substantive content", () => {
    const d = detectPrivacySignal("  Off The Record.  ");
    expect(d.signal).toBe("enter-private");
    expect(d.hasSubstantiveContent).toBe(false);
  });

  it("normalises curly apostrophes so smart-quoted contractions still match", () => {
    const d = detectPrivacySignal("don’t remember this");
    expect(d.signal).toBe("enter-private");
  });
});

describe("detectPrivacySignal — exit-private markers (§3.3)", () => {
  it("catches each explicit exit phrase on its own", () => {
    for (const marker of DEFAULT_PUBLIC_MARKERS) {
      const d = detectPrivacySignal(marker);
      expect(d.signal, marker).toBe("exit-private");
    }
  });

  it("applies the exit signal even with trailing substantive content (resumes next prompt)", () => {
    const d = detectPrivacySignal("you can remember again — let's get back to the refactor");
    expect(d.signal).toBe("exit-private");
    expect(d.hasSubstantiveContent).toBe(true);
  });
});

describe("detectPrivacySignal — toggle command (§3.1)", () => {
  it("recognises the hyphen and colon forms as a pure toggle", () => {
    expect(detectPrivacySignal("/lib-toggle-private").signal).toBe("toggle");
    expect(detectPrivacySignal("  /lib:toggle-private  ").signal).toBe("toggle");
  });

  it("does not treat the command embedded in prose as a toggle", () => {
    expect(detectPrivacySignal("run /lib-toggle-private to flip mode").signal).toBe("none");
  });
});

describe("detectPrivacySignal — no false positives (§11.1)", () => {
  it("returns none for unrelated prose", () => {
    const d = detectPrivacySignal(
      "Please refactor the private fields in this class to be readonly.",
    );
    expect(d.signal).toBe("none");
  });

  it("returns none for an empty prompt", () => {
    expect(detectPrivacySignal("").signal).toBe("none");
  });

  it("private markers take precedence over exit markers in the same prompt", () => {
    const d = detectPrivacySignal("you can remember again but actually keep this between us");
    expect(d.signal).toBe("enter-private");
  });
});

describe("detectPrivacySignal — custom marker lists", () => {
  it("honours caller-supplied markers", () => {
    const d = detectPrivacySignal("zip it", {
      privateMarkers: ["zip it"],
      publicMarkers: ["unzip"],
    });
    expect(d.signal).toBe("enter-private");
  });
});
