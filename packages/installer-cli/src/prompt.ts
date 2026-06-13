// A tiny `node:readline`-based prompt layer, injectable for tests.
//
// Two surfaces:
//   - `selectHarnesses(available)` — a numbered multi-select; the user types
//     numbers (`1 3`), `all`, or `none`.
//   - `promptText(question, opts)` — a single line; `secret` suppresses the
//     echo (for the token).
//
// EVERYTHING is injectable so tests never touch a real TTY or stdin:
//   - pass a `prompt` fn to answer questions deterministically, OR
//   - pass `input`/`output` streams the readline reads from / writes to.
// Non-interactive (no TTY, no injected prompt) NEVER hangs: `selectHarnesses`
// falls back to "everything available", and `promptText` returns the default
// (or throws a clear error when a required value has no default).

import readline from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface PromptTextOptions {
  /** Value used when the user just hits enter (or in non-interactive mode). */
  default?: string;
  /** Don't echo the typed characters (used for the token). */
  secret?: boolean;
}

/**
 * The injectable prompt function. Given a fully-rendered question (the caller
 * has already appended any `[default]` hint), it resolves the user's raw
 * answer. `secret` lets a fake distinguish a token prompt if it wants to.
 */
export type PromptFn = (question: string, opts: { secret: boolean }) => Promise<string>;

export interface Prompter {
  selectHarnesses(available: HarnessChoice[]): Promise<string[]>;
  promptText(question: string, opts?: PromptTextOptions): Promise<string>;
  /**
   * Release any resources held for interactive prompting (the shared readline
   * interface). Safe to call when nothing was opened, and idempotent. Callers
   * MUST invoke this once the prompting phase is done — an open readline keeps
   * the Node event loop alive, so the process won't exit until it's closed.
   */
  close(): void;
}

/** A pickable harness in the multi-select. */
export interface HarnessChoice {
  id: string;
  label: string;
}

export interface PrompterOptions {
  /** Inject a deterministic answer function (tests). Wins over streams. */
  prompt?: PromptFn;
  /** The stream questions are read from. Defaults to `process.stdin`. */
  input?: Readable;
  /** The stream prompts/labels are written to. Defaults to `process.stdout`. */
  output?: Writable;
  /**
   * Force interactive vs non-interactive. Defaults to whether `input` is a
   * TTY. Non-interactive never blocks on a read.
   */
  interactive?: boolean;
}

/** A clear, typed error thrown when a required value can't be obtained. */
export class MissingValueError extends Error {
  constructor(what: string) {
    super(`${what} is required but no value was provided (non-interactive run).`);
    this.name = "MissingValueError";
  }
}

/** Build a Prompter over the given options (defaults to the real stdio). */
export function createPrompter(options: PrompterOptions = {}): Prompter {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const interactive =
    options.interactive ??
    (options.prompt !== undefined ? true : Boolean((input as { isTTY?: boolean }).isTTY));

  // ONE line reader (over ONE readline interface) for this prompter's whole
  // lifetime. Created lazily on the first real prompt — so a non-interactive
  // or injected-`prompt` run never opens stdin — and reused for EVERY question.
  //
  // The old code built a FRESH `createInterface` per question and `rl.close()`d
  // it. Closing the first interface discarded the input buffered past its line,
  // so a second read over a single shared stream (e.g. a piped
  // `librarian install <<EOF`, where both answers arrive in one chunk) never
  // saw its input and the read hung — `resolveConfig` then threw "required".
  // `close()` (called from the command lifecycle) tears the reader down exactly
  // once so the open readline doesn't keep the Node event loop alive.
  let reader: LineReader | undefined;
  const lineReader = (): LineReader => {
    if (!reader) reader = createLineReader(input, output);
    return reader;
  };

  const ask: PromptFn =
    options.prompt ?? ((question, opts) => lineReader().ask(question, opts.secret));

  return {
    async selectHarnesses(available) {
      if (available.length === 0) return [];
      if (!interactive && options.prompt === undefined) {
        // No way to ask — default to every available harness.
        return available.map((h) => h.id);
      }
      write(output, "Select harnesses to install:\n");
      available.forEach((h, i) => write(output, `  ${i + 1}) ${h.label}\n`));
      write(output, "Enter numbers (e.g. 1 3), 'all', or 'none' [all]: ");
      const answer = (await ask("", { secret: false })).trim();
      return resolveSelection(answer, available);
    },

    async promptText(question, opts = {}) {
      const hasDefault = opts.default !== undefined;
      if (!interactive && options.prompt === undefined) {
        if (hasDefault) return opts.default as string;
        throw new MissingValueError(question);
      }
      const hint = hasDefault && !opts.secret ? ` [${opts.default}]` : "";
      const raw = (await ask(`${question}${hint}: `, { secret: Boolean(opts.secret) })).trim();
      if (raw.length === 0 && hasDefault) return opts.default as string;
      if (raw.length === 0 && !hasDefault) throw new MissingValueError(question);
      return raw;
    },

    close() {
      // Idempotent: only the shared reader (if one was ever opened) is torn
      // down. An open readline keeps the Node event loop alive, so the command
      // lifecycle MUST call this once prompting is done or the process hangs.
      if (reader) {
        reader.close();
        reader = undefined;
      }
    },
  };
}

/** Map a multi-select answer string to the chosen harness ids. */
export function resolveSelection(answer: string, available: HarnessChoice[]): string[] {
  const normalized = answer.trim().toLowerCase();
  if (normalized === "" || normalized === "all") return available.map((h) => h.id);
  if (normalized === "none") return [];
  const picked = new Set<string>();
  for (const token of normalized.split(/[\s,]+/).filter(Boolean)) {
    const n = Number.parseInt(token, 10);
    if (Number.isInteger(n) && n >= 1 && n <= available.length) {
      const choice = available[n - 1];
      if (choice) picked.add(choice.id);
    }
  }
  return available.filter((h) => picked.has(h.id)).map((h) => h.id);
}

// --- readline plumbing ---------------------------------------------------

function write(output: Writable, text: string): void {
  output.write(text);
}

/**
 * A long-lived line reader over ONE shared `readline` interface.
 *
 * Why not just call `rl.question` per prompt: readline emits a `line` event
 * for EVERY newline in a chunk, the moment the chunk arrives. When a piped run
 * delivers both answers in one chunk (`url\ntoken\n`), the line for `token` is
 * emitted before the second `rl.question` registers its one-shot callback — so
 * that input would be dropped. Instead we attach a PERSISTENT `line` listener
 * that queues lines; `ask()` consumes a queued line if one is waiting, else
 * parks a resolver for the next. No input is ever lost regardless of chunking.
 */
interface LineReader {
  ask(question: string, secret: boolean): Promise<string>;
  close(): void;
}

function createLineReader(input: Readable, output: Writable): LineReader {
  const rl = readline.createInterface({ input, output, terminal: true });
  const queue: string[] = [];
  let waiting: ((line: string) => void) | null = null;

  rl.on("line", (line: string) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else {
      queue.push(line);
    }
  });

  // The original echo writer; restored after each secret question so a later
  // non-secret prompt renders normally. Typed to allow `undefined` so the
  // restore assignment is sound under `exactOptionalPropertyTypes`.
  const ref = rl as unknown as { _writeToOutput: ((s: string) => void) | undefined };

  const nextLine = (): Promise<string> =>
    new Promise((resolve) => {
      const queued = queue.shift();
      if (queued !== undefined) resolve(queued);
      else waiting = resolve;
    });

  return {
    async ask(question, secret) {
      if (!secret) {
        if (question) write(output, question);
        return nextLine();
      }
      // Mute the echo just for this question: swallow each typed character so
      // the token never renders, passing only newlines through. Restore the
      // original writer afterwards so a following non-secret prompt echoes.
      const original = ref._writeToOutput;
      ref._writeToOutput = (s: string) => {
        if (s.includes("\n") || s.includes("\r")) original?.call(rl, s);
      };
      try {
        if (question) write(output, question);
        const line = await nextLine();
        return line;
      } finally {
        ref._writeToOutput = original;
        write(output, "\n");
      }
    },
    close() {
      rl.close();
    },
  };
}
