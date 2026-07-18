import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { IsoTimestampSchema } from "../../schemas/common.js";

export const REFUSAL_LOG_FILE = "refusal-log.ndjson";
export const REFUSAL_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const REFUSAL_LOG_BUCKET_CAPACITY = 120;
export const REFUSAL_LOG_REFILL_PER_SECOND = 2;

export const RefusalDenialKindSchema = z.enum([
  "bearer-missing",
  "bearer-invalid",
  "bearer-wrong-scope",
  "origin-blocked",
  "rate-limited",
  "trpc-unauthorized",
  "tool-admin-only",
  "password-failed",
  "password-lockout",
  "setup-link-refused",
  "enable-refused",
  "claim-refused",
  "shelf-not-writable",
  "shelf-outside-write-set",
]);

export const RefusalSurfaceSchema = z.enum(["public", "internal", "store"]);
export const RefusalOutcomeSchema = z.union([
  z.literal(401),
  z.literal(403),
  z.literal(429),
  z.literal("locked"),
  z.literal("refused"),
]);

export const RefusalDenialSchema = z
  .object({
    v: z.literal(1),
    ts: IsoTimestampSchema,
    kind: RefusalDenialKindSchema,
    surface: RefusalSurfaceSchema,
    outcome: RefusalOutcomeSchema,
    path: z.string().optional(),
    procedure: z.string().optional(),
    tool: z.string().optional(),
    username: z.string().optional(),
    actorId: z.string().optional(),
    roles: z.array(z.string()).optional(),
    tokenId: z.string().optional(),
    tokenHash: z.string().optional(),
    ip: z.string().optional(),
    forwardedFor: z.string().optional(),
    origin: z.string().optional(),
    detail: z.string().optional(),
  })
  .strict();

export const RefusalDroppedSchema = z
  .object({
    v: z.literal(1),
    ts: IsoTimestampSchema,
    kind: z.literal("dropped"),
    count: z.number().int().positive(),
    windowStart: IsoTimestampSchema,
  })
  .strict();

export const RefusalRecordSchema = z.discriminatedUnion("kind", [
  RefusalDenialSchema,
  RefusalDroppedSchema,
]);

export type RefusalDenialKind = z.infer<typeof RefusalDenialKindSchema>;
export type RefusalSurface = z.infer<typeof RefusalSurfaceSchema>;
export type RefusalOutcome = z.infer<typeof RefusalOutcomeSchema>;
export type RefusalDenial = z.infer<typeof RefusalDenialSchema>;
export type RefusalDropped = z.infer<typeof RefusalDroppedSchema>;
export type RefusalRecord = z.infer<typeof RefusalRecordSchema>;
export type RecordRefusalInput = Omit<RefusalDenial, "v" | "ts">;

export interface ReadRefusalsOptions {
  limit?: number;
  offset?: number;
  kind?: RefusalRecord["kind"];
}

export interface ReadRefusalsResult {
  rows: RefusalRecord[];
  total: number;
  dropped: number;
}

export type RefusalLogErrorSink = (error: unknown) => void;

export interface RefusalLog {
  record(input: RecordRefusalInput): Promise<void>;
  read(options?: ReadRefusalsOptions): Promise<ReadRefusalsResult>;
}

/**
 * Construction dependencies for the bounded sidecar. The sizing/rate options
 * are internal test seams; production callers use the exported fixed defaults.
 */
export interface RefusalLogDeps {
  filePath: string;
  armed: boolean;
  onError?: RefusalLogErrorSink;
  now?: () => Date;
  maxBytes?: number;
  bucketCapacity?: number;
  bucketRefillPerSecond?: number;
}

const EMPTY_RESULT: ReadRefusalsResult = { rows: [], total: 0, dropped: 0 };

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * One process-local refusal sink. Callers arm exactly one instance in the HTTP
 * process; all other stores retain the inert writer while sharing this read API.
 */
export function createRefusalLog(deps: RefusalLogDeps): RefusalLog {
  const active = deps.armed && process.env.LIBRARIAN_REFUSAL_LOG !== "false";
  const now = deps.now ?? (() => new Date());
  const maxBytes = deps.maxBytes ?? REFUSAL_LOG_MAX_BYTES;
  const capacity = deps.bucketCapacity ?? REFUSAL_LOG_BUCKET_CAPACITY;
  const refillPerSecond = deps.bucketRefillPerSecond ?? REFUSAL_LOG_REFILL_PER_SECOND;

  if (maxBytes <= 0 || capacity <= 0 || refillPerSecond <= 0) {
    throw new Error("refusal-log bounds must all be greater than zero");
  }

  let tokens = capacity;
  let lastRefillMs: number | undefined;
  let droppedCount = 0;
  let droppedWindowStart: string | undefined;
  let errorReported = false;
  let queue: Promise<void> = Promise.resolve();

  const reportError = (error: unknown): void => {
    if (errorReported) return;
    errorReported = true;
    try {
      deps.onError?.(error);
    } catch {
      // Observability must remain fail-open even when its diagnostic sink fails.
    }
  };

  const refill = (atMs: number): void => {
    if (lastRefillMs === undefined) {
      lastRefillMs = atMs;
      return;
    }
    const elapsedMs = Math.max(0, atMs - lastRefillMs);
    tokens = Math.min(capacity, tokens + (elapsedMs / 1_000) * refillPerSecond);
    lastRefillMs = atMs;
  };

  const rotateIfNeeded = async (lineBytes: number): Promise<void> => {
    let currentSize = 0;
    try {
      currentSize = (await fs.stat(deps.filePath)).size;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (currentSize === 0 || currentSize + lineBytes <= maxBytes) return;

    const priorPath = `${deps.filePath}.1`;
    await fs.rm(priorPath, { force: true });
    try {
      await fs.rename(deps.filePath, priorPath);
      await fs.chmod(priorPath, 0o600);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  };

  const append = async (record: RefusalRecord): Promise<void> => {
    const parsed = RefusalRecordSchema.safeParse(record);
    if (!parsed.success) {
      throw new Error("refusal record failed schema validation");
    }
    const line = Buffer.from(`${JSON.stringify(parsed.data)}\n`, "utf8");
    if (line.byteLength > maxBytes) {
      throw new Error("refusal record exceeds the refusal-log generation bound");
    }
    await fs.mkdir(path.dirname(deps.filePath), { recursive: true });
    await rotateIfNeeded(line.byteLength);
    const handle = await fs.open(
      deps.filePath,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.chmod(0o600);
      const { bytesWritten } = await handle.write(line, 0, line.byteLength, null);
      if (bytesWritten !== line.byteLength) {
        throw new Error("refusal-log append was incomplete");
      }
    } finally {
      await handle.close();
    }
  };

  const performRecord = async (input: RecordRefusalInput): Promise<void> => {
    const at = now();
    const ts = at.toISOString();
    const denialCandidate = { v: 1 as const, ts, ...input };
    const denial = RefusalDenialSchema.safeParse(denialCandidate);
    if (!denial.success) {
      throw new Error("refusal record failed schema validation");
    }

    refill(at.getTime());
    if (droppedCount > 0 && droppedWindowStart !== undefined && tokens >= 1) {
      const dropped: RefusalDropped = {
        v: 1,
        ts,
        kind: "dropped",
        count: droppedCount,
        windowStart: droppedWindowStart,
      };
      await append(dropped);
      tokens -= 1;
      droppedCount = 0;
      droppedWindowStart = undefined;
    }

    if (tokens < 1) {
      droppedCount += 1;
      droppedWindowStart ??= ts;
      return;
    }

    tokens -= 1;
    await append(denial.data);
  };

  const record = (input: RecordRefusalInput): Promise<void> => {
    if (!active) return Promise.resolve();
    const operation = queue.then(() => performRecord(input));
    queue = operation.catch(reportError);
    return queue;
  };

  const readFile = async (filePath: string): Promise<RefusalRecord[]> => {
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const complete = content.endsWith("\n")
      ? content
      : content.slice(0, content.lastIndexOf("\n") + 1);
    if (complete.length === 0) return [];
    const rows: RefusalRecord[] = [];
    for (const line of complete.split("\n")) {
      if (line.length === 0) continue;
      try {
        const parsed = RefusalRecordSchema.safeParse(JSON.parse(line));
        if (parsed.success) rows.push(parsed.data);
      } catch {
        // Corrupt and torn rows are evidence gaps, never availability failures.
      }
    }
    return rows;
  };

  const performRead = async (options: ReadRefusalsOptions): Promise<ReadRefusalsResult> => {
    const [prior, current] = await Promise.all([
      readFile(`${deps.filePath}.1`),
      readFile(deps.filePath),
    ]);
    const newestFirst = [...prior, ...current].reverse();
    const filtered =
      options.kind === undefined
        ? newestFirst
        : newestFirst.filter((record) => record.kind === options.kind);
    const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 200)));
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const rows = filtered.slice(offset, offset + limit);
    const dropped = rows.reduce(
      (sum, record) => sum + (record.kind === "dropped" ? record.count : 0),
      0,
    );
    return { rows, total: filtered.length, dropped };
  };

  const read = (options: ReadRefusalsOptions = {}): Promise<ReadRefusalsResult> => {
    const operation = queue.then(() => performRead(options));
    const result = operation.catch((error: unknown) => {
      reportError(error);
      return { ...EMPTY_RESULT };
    });
    queue = result.then(() => undefined);
    return result;
  };

  return { record, read };
}
