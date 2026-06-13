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

  const ask: PromptFn =
    options.prompt ?? ((question, opts) => readLine(input, output, question, opts.secret));

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

/** Read one line, optionally with the echo muted (secret entry). */
function readLine(
  input: Readable,
  output: Writable,
  question: string,
  secret: boolean,
): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input,
      output,
      terminal: true,
    });
    if (secret) {
      // Mute the echo: overwrite each keystroke so the token never renders.
      const muteWrite = (rl as unknown as { _writeToOutput?: (s: string) => void })._writeToOutput;
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (s.includes("\n") || s.includes("\r")) {
          muteWrite?.call(rl, s);
        }
        // else: swallow the character so it isn't echoed.
      };
      if (question) write(output, question);
      rl.question("", (answer) => {
        write(output, "\n");
        rl.close();
        resolve(answer);
      });
      return;
    }
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
