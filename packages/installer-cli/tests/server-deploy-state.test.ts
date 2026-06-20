// `server/deploy-state.ts` — the NON-SECRET deploy-state file that lets
// `update` recreate the container with the same config and `status` report the
// deployed ref reliably. It lives in the deploy dir (default
// `~/.librarian/server/deploy-state.json`) and carries NO token/key — ever.
//
// These tests assert the round-trip, the path-injection (works under a fake
// home), and — load-bearing for "data is sacred" / "no leaks" — that no secret
// shape can be written to it.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deployStatePath,
  readDeployState,
  writeDeployState,
  type DeployState,
} from "../src/server/deploy-state.js";
import { withTempHome } from "./helpers.js";

const SAMPLE: DeployState = {
  containerName: "the-librarian",
  host: "127.0.0.1",
  dataVolume: "librarian_data",
  ref: "v1.4.2",
  imageTag: "the-librarian:v1.4.2",
};

describe("deploy-state — round-trip under a fake home", () => {
  it("writeDeployState then readDeployState returns the same state", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      writeDeployState(dir, SAMPLE);
      expect(readDeployState(dir)).toEqual(SAMPLE);
    });
  });

  it("round-trips the optional host data dir when present", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      const withDir: DeployState = { ...SAMPLE, dataDir: "/srv/librarian" };
      writeDeployState(dir, withDir);
      expect(readDeployState(dir)).toEqual(withDir);
      const parsed = JSON.parse(fs.readFileSync(deployStatePath(dir), "utf8")) as Record<
        string,
        unknown
      >;
      expect(parsed.dataDir).toBe("/srv/librarian");
    });
  });

  it("a named-volume state omits dataDir and an older (dataDir-less) file still parses", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      writeDeployState(dir, SAMPLE); // no dataDir
      const parsed = JSON.parse(fs.readFileSync(deployStatePath(dir), "utf8")) as Record<
        string,
        unknown
      >;
      expect("dataDir" in parsed).toBe(false);
      // A state written before dataDir existed must still read back cleanly.
      expect(readDeployState(dir)).toEqual(SAMPLE);
    });
  });

  it("writes to <dir>/deploy-state.json and creates the dir if absent", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      expect(fs.existsSync(dir)).toBe(false);
      writeDeployState(dir, SAMPLE);
      expect(fs.existsSync(deployStatePath(dir))).toBe(true);
      expect(deployStatePath(dir)).toBe(path.join(dir, "deploy-state.json"));
    });
  });

  it("readDeployState returns null when the file is absent", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      expect(readDeployState(dir)).toBeNull();
    });
  });

  it("readDeployState returns null on malformed JSON (never throws)", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(deployStatePath(dir), "{ not json", "utf8");
      expect(readDeployState(dir)).toBeNull();
    });
  });

  it("readDeployState returns null when required fields are missing", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(deployStatePath(dir), JSON.stringify({ host: "127.0.0.1" }), "utf8");
      expect(readDeployState(dir)).toBeNull();
    });
  });
});

describe("deploy-state — carries NO secret (the file is non-secret)", () => {
  it("the serialized state contains exactly the five non-secret fields", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      writeDeployState(dir, SAMPLE);
      const parsed = JSON.parse(fs.readFileSync(deployStatePath(dir), "utf8")) as Record<
        string,
        unknown
      >;
      expect(Object.keys(parsed).sort()).toEqual(
        ["containerName", "dataVolume", "host", "imageTag", "ref"].sort(),
      );
    });
  });

  it("a secret-shaped value smuggled onto the input is NOT persisted", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      // Assemble a secret-shaped literal at runtime (GitGuardian scans commits).
      const fakeToken = "tok_" + "0123456789abcdef".repeat(4);
      // Even if a caller passes extra keys, writeDeployState only ever persists
      // the five declared non-secret fields.
      writeDeployState(dir, {
        ...SAMPLE,
        // @ts-expect-error — extra keys are not part of DeployState and must be dropped.
        token: fakeToken,
        // @ts-expect-error — same for an admin token / master key.
        adminToken: fakeToken,
      });
      const raw = fs.readFileSync(deployStatePath(dir), "utf8");
      expect(raw).not.toContain(fakeToken);
      expect(raw).not.toContain("token");
    });
  });
});
