// Read a single line from a TTY with echo OFF — for bearer-grade secrets (master
// keys, passwords) that must not land on screen or in terminal scrollback. Reads
// byte-by-byte in raw mode and assumes ASCII input (hex/base64 keys, ASCII
// passwords) — a pasted multi-byte char would be split; non-ASCII passwords should
// use the --password flag or the browser reset page. Returns null when there's no
// TTY (non-interactive) or the operator cancels with Ctrl-C.

import fs from "node:fs";

export function readHiddenLine(promptText: string): string | null {
  const stdin = process.stdin;
  if (!stdin.isTTY) return null;
  process.stdout.write(promptText);
  const wasRaw = stdin.isRaw === true;
  try {
    stdin.setRawMode?.(true);
    const buf = Buffer.alloc(1);
    let input = "";
    while (true) {
      if (fs.readSync(0, buf, 0, 1, null) === 0) break;
      const byte = buf[0];
      if (byte === 0x0a || byte === 0x0d) break; // Enter
      if (byte === 0x03) return null; // Ctrl-C → cancel
      if (byte === 0x7f || byte === 0x08) {
        input = input.slice(0, -1); // Backspace / DEL
        continue;
      }
      input += buf.toString("utf8");
    }
    return input.trim() || null;
  } catch {
    return null;
  } finally {
    stdin.setRawMode?.(wasRaw);
    process.stdout.write("\n");
  }
}
