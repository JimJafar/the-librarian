import { z } from "zod";
import type { LlmConnectionReader, LlmConnectionWriter } from "../llm-connection.js";

/** The Chronicle schedule and its LLM consumer share one authoritative enablement setting. */
export const CHRONICLE_ENABLED_KEY = "chronicle.enabled";
export const LAST_CHRONICLE_RUN_KEY = "chronicle.last_run_at";

const DAY_KEY = "chronicle.day_of_week";
const TIME_KEY = "chronicle.schedule_time";
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export const CHRONICLE_DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type ChronicleDay = (typeof CHRONICLE_DAYS)[number];

export interface ChronicleConfig {
  enabled: boolean;
  dayOfWeek: ChronicleDay;
  scheduleTime: string;
}

export interface ChronicleConfigPatch {
  enabled?: boolean;
  dayOfWeek?: ChronicleDay;
  scheduleTime?: string;
}

export const ChronicleConfigPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  dayOfWeek: z.enum(CHRONICLE_DAYS).optional(),
  scheduleTime: z.string().optional(),
});

type ConfigReader = LlmConnectionReader;
type ConfigWriter = LlmConnectionWriter;

export function readChronicleConfig(store: ConfigReader): ChronicleConfig {
  const rawDay = store.getSetting(DAY_KEY);
  const rawTime = store.getSetting(TIME_KEY);
  return {
    enabled: store.getSetting(CHRONICLE_ENABLED_KEY) === "true",
    dayOfWeek: isDay(rawDay) ? rawDay : "monday",
    scheduleTime: rawTime !== null && TIME_PATTERN.test(rawTime) ? rawTime : "08:00",
  };
}

export function writeChronicleConfig(
  store: ConfigReader & ConfigWriter,
  patch: ChronicleConfigPatch,
): ChronicleConfig {
  if (patch.dayOfWeek !== undefined && !isDay(patch.dayOfWeek)) {
    throw new Error(`chronicle.day_of_week must be one of ${CHRONICLE_DAYS.join(", ")}`);
  }
  if (patch.scheduleTime !== undefined && !TIME_PATTERN.test(patch.scheduleTime)) {
    throw new Error("chronicle.schedule_time must use 24h HH:MM (00:00–23:59)");
  }
  if (patch.enabled !== undefined) {
    store.setSetting(CHRONICLE_ENABLED_KEY, patch.enabled ? "true" : "false");
  }
  if (patch.dayOfWeek !== undefined) store.setSetting(DAY_KEY, patch.dayOfWeek);
  if (patch.scheduleTime !== undefined) store.setSetting(TIME_KEY, patch.scheduleTime);
  return readChronicleConfig(store);
}

export function readLastChronicleRunAt(store: ConfigReader): Date | null {
  const raw = store.getSetting(LAST_CHRONICLE_RUN_KEY);
  if (raw === null) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function writeLastChronicleRunAt(store: ConfigWriter, at: Date): void {
  store.setSetting(LAST_CHRONICLE_RUN_KEY, at.toISOString());
}

function isDay(value: string | null): value is ChronicleDay {
  return value !== null && (CHRONICLE_DAYS as readonly string[]).includes(value);
}
