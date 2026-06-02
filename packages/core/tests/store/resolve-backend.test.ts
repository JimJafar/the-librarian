// resolveBackend tests (plan 036 Phase 7 cutover). The shipped server/CLI boot
// defaults to markdown; LIBRARIAN_BACKEND=sqlite is the explicit opt-out. (The
// createLibrarianStore library default stays sqlite — covered elsewhere.)

import { resolveBackend } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let prev: string | undefined;

beforeEach(() => {
  prev = process.env.LIBRARIAN_BACKEND;
});

afterEach(() => {
  if (prev === undefined) delete process.env.LIBRARIAN_BACKEND;
  else process.env.LIBRARIAN_BACKEND = prev;
});

describe("resolveBackend", () => {
  it("defaults to markdown when LIBRARIAN_BACKEND is unset (the cutover default)", () => {
    delete process.env.LIBRARIAN_BACKEND;
    expect(resolveBackend()).toBe("markdown");
  });

  it("returns sqlite as the explicit opt-out", () => {
    process.env.LIBRARIAN_BACKEND = "sqlite";
    expect(resolveBackend()).toBe("sqlite");
  });

  it("honours an explicit markdown", () => {
    process.env.LIBRARIAN_BACKEND = "markdown";
    expect(resolveBackend()).toBe("markdown");
  });

  it("throws on an unrecognized value (catches typos)", () => {
    process.env.LIBRARIAN_BACKEND = "sqlit";
    expect(() => resolveBackend()).toThrow(/LIBRARIAN_BACKEND/);
  });
});
