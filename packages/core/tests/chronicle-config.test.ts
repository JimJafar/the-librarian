import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createLibrarianStore,
  readChronicleConfig,
  writeChronicleConfig,
  type LibrarianStore,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let store: LibrarianStore;
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-chronicle-config-"));
  store = createLibrarianStore({ dataDir });
});

afterEach(() => {
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("Chronicle config", () => {
  it("defaults off on Monday at 08:00", () => {
    expect(readChronicleConfig(store)).toEqual({
      enabled: false,
      dayOfWeek: "monday",
      scheduleTime: "08:00",
    });
  });

  it("round-trips valid patches", () => {
    writeChronicleConfig(store, { enabled: true, dayOfWeek: "friday", scheduleTime: "17:30" });
    expect(readChronicleConfig(store)).toEqual({
      enabled: true,
      dayOfWeek: "friday",
      scheduleTime: "17:30",
    });
  });

  it("rejects invalid days and local times before writing", () => {
    expect(() => writeChronicleConfig(store, { dayOfWeek: "funday" as "monday" })).toThrow(
      /day_of_week/,
    );
    expect(() => writeChronicleConfig(store, { scheduleTime: "24:00" })).toThrow(/schedule_time/);
    expect(readChronicleConfig(store)).toEqual({
      enabled: false,
      dayOfWeek: "monday",
      scheduleTime: "08:00",
    });
  });
});
