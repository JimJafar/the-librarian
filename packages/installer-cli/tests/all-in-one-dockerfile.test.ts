// S7a — the all-in-one image must bundle the admin CLI (`@librarian/cli`, the
// `the-librarian` binary) so `server admin` can `docker exec the-librarian
// the-librarian <verb>` (spec §7).
//
// A real `docker build` is slow (minutes; pulls + compiles), so the build is
// verified separately/by hand. THIS test is a fast, static guard on the
// Dockerfile contract — the things that, if dropped, silently break
// `server admin` at runtime:
//   1. the BUILDER copies the `packages/cli` SOURCE (it can't build what isn't
//      there), then BUILDS `@librarian/cli`;
//   2. the RUNTIME stage copies the built CLI tree (its dist + package.json +
//      node_modules, plus the `@librarian/core` dist it imports);
//   3. `the-librarian` is reachable on PATH at runtime.
// It mirrors the existing, working mcp-server runtime-tree copy.

import fs from "node:fs";
import { describe, expect, it } from "vitest";

/** The all-in-one Dockerfile, read once (repo root is three dirs up from tests/). */
const dockerfile = fs.readFileSync(
  new URL("../../../docker/all-in-one.Dockerfile", import.meta.url),
  "utf8",
);

/** Collapse whitespace so a multi-line `RUN … \` reads as one string to match. */
const flat = dockerfile.replace(/\\\n/g, " ").replace(/[ \t]+/g, " ");

describe("all-in-one.Dockerfile — builder builds the admin CLI", () => {
  it("copies the packages/cli SOURCE into the builder (can't build what's absent)", () => {
    // The source COPY (not just the package.json manifest copy on line ~22).
    expect(flat).toMatch(/COPY packages\/cli \.\/packages\/cli/);
  });

  it("builds @librarian/cli alongside core/mcp-server", () => {
    // A `pnpm … --filter @librarian/cli … run build` somewhere in the builder.
    expect(flat).toMatch(/pnpm[^\n]*--filter @librarian\/cli[^\n]*run build/);
  });
});

describe("all-in-one.Dockerfile — runtime stage bundles the admin CLI tree", () => {
  it("copies the built CLI dist into the runtime image", () => {
    expect(flat).toMatch(/COPY --from=builder \/app\/packages\/cli\/dist \S+/);
  });

  it("copies the CLI package.json so Node resolves its bin/main", () => {
    expect(flat).toMatch(/COPY --from=builder \/app\/packages\/cli\/package\.json \S+/);
  });

  it("copies the @librarian/core dist the CLI imports into the CLI subtree", () => {
    // The CLI depends on @librarian/core; its dist must live under the CLI tree
    // (mirrors how the mcp-server tree carries packages/core/dist).
    expect(flat).toMatch(/COPY --from=builder \/app\/packages\/core\/dist \/app\/cli\/\S+/);
  });

  it("puts `the-librarian` on PATH at runtime (symlink or PATH entry)", () => {
    const onPath =
      /ln -s\S* [^\n]*the-librarian/.test(flat) || // symlink into a PATH dir
      /ENV PATH=[^\n]*\/app\/cli/.test(flat) || // CLI bin dir prepended to PATH
      /\/usr\/local\/bin\/the-librarian/.test(flat);
    expect(onPath).toBe(true);
  });
});
