import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatSessionStart } from "@librarian/mcp-server/formatters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// End-to-end proof that the harness adapters SELECT THE REMOTE TRANSPORT when
// LIBRARIAN_MCP_URL is set: drive each built hook bin with a remote env and
// assert the fake /mcp receives the session calls.
//
// The hook bin is launched with ASYNC spawn so this process's event loop stays
// free to service the in-process server. The bin internally spawnSyncs the
// mcp-call helper (a grandchild) which connects here — no deadlock, because the
// blocked spawnSync is in the bin's process, not ours.
const binDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin");

function rpc(text: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });
}

let server: http.Server;
let url: string;
let toolNames: string[];

beforeAll(async () => {
  toolNames = [];
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const name = JSON.parse(Buffer.concat(chunks).toString("utf8")).params?.name as string;
      toolNames.push(name);
      const text =
        name === "list_sessions"
          ? "No resumable sessions found."
          : name === "start_session"
            ? formatSessionStart({
                id: "ses_e2e",
                status: "active",
                title: "T",
                visibility: "common",
                project_key: null,
                current_harness: "claude-code",
              } as never)
            : "ok";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(rpc(text));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function runHook(
  binName: string,
  event: object,
): Promise<{ status: number | null; stdout: string }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lib-e2e-home-"));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(binDir, binName)], {
      env: {
        ...process.env,
        HOME: home,
        LIBRARIAN_MCP_URL: url,
        LIBRARIAN_AGENT_TOKEN: "tok_e2e",
      },
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (status) => {
      fs.rmSync(home, { recursive: true, force: true });
      resolve({ status, stdout });
    });
    child.stdin.write(JSON.stringify(event));
    child.stdin.end();
  });
}

// Codex used to be in this matrix; it moved to the standalone
// the-librarian-codex-plugin (with its own bundled hook + smoke), so this
// suite only covers the Claude Code path now.
describe("claude-code-hook.js — remote transport selection (e2e)", () => {
  it("drives the remote Librarian on a prompt and keeps the hook contract (exit 0, no stdout)", async () => {
    toolNames.length = 0;
    const r = await runHook("claude-code-hook.js", {
      hook_event_name: "UserPromptSubmit",
      session_id: "s-e2e",
      cwd: "/tmp/lib-e2e-proj",
      prompt: "hello there",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(""); // UserPromptSubmit stdout would pollute the model's context
    // Fresh state → list (no matches) then start, both against the remote /mcp.
    expect(toolNames).toContain("list_sessions");
    expect(toolNames).toContain("start_session");
  });
});
