import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { hostname, machineId } from "../src/machine.js";
import { machineIdPath } from "../src/paths.js";
import { withTempHome } from "./helpers.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("machineId", () => {
  it("generates a UUID on first call", async () => {
    await withTempHome((home) => {
      const id = machineId(home);
      expect(id).toMatch(UUID_RE);
      expect(fs.existsSync(machineIdPath(home))).toBe(true);
    });
  });

  it("returns the same id on the second call (stable)", async () => {
    await withTempHome((home) => {
      const first = machineId(home);
      const second = machineId(home);
      expect(second).toBe(first);
    });
  });

  it("persists across a fresh read of the file", async () => {
    await withTempHome((home) => {
      const id = machineId(home);
      const onDisk = fs.readFileSync(machineIdPath(home), "utf8").trim();
      expect(onDisk).toBe(id);
    });
  });

  it("regenerates when the file is blank", async () => {
    await withTempHome((home) => {
      machineId(home);
      fs.writeFileSync(machineIdPath(home), "   \n");
      const regenerated = machineId(home);
      expect(regenerated).toMatch(UUID_RE);
    });
  });

  it("two homes get distinct ids", async () => {
    await withTempHome(async (homeA) => {
      await withTempHome((homeB) => {
        expect(machineId(homeA)).not.toBe(machineId(homeB));
      });
    });
  });
});

describe("hostname", () => {
  it("returns a non-empty string", () => {
    expect(hostname().length).toBeGreaterThan(0);
  });
});
