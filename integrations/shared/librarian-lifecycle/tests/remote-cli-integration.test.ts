import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LibrarianCliError } from "../src/cli.js";
import { createRemoteLibrarianCli } from "../src/remote-cli.js";

// Exercises the REAL default runner end-to-end: createRemoteLibrarianCli with NO
// injected runner → real spawnSync of the built mcp-call bin → a fake /mcp.
//
// The fake server runs OUT OF PROCESS (a separate node), which is essential here:
// the remote CLI uses spawnSync, which blocks this thread, so an in-process server
// would deadlock. In production the Librarian is remote, so this is the real shape.
const here = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.join(here, "..", "dist", "bin", "mcp-call.js");

const SERVER_SOURCE = `
import http from "node:http";
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let name = "";
    try { name = JSON.parse(body).params?.name ?? ""; } catch {}
    const text =
      name === "start_session"
        ? "Session started.\\nID: ses_int\\nStatus: active\\nTitle: T\\nProject: (none)"
        : name === "list_sessions"
        ? "Resumable sessions (1 of 1):\\n\\n1. [active] T — no project — claude-code — last: x\\n   id: ses_int\\n"
        : "ok";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } }));
  });
});
server.listen(0, "127.0.0.1", () => process.stdout.write("PORT:" + server.address().port + "\\n"));
`;

let serverProc: ChildProcess;
let serverFile: string;
let url: string;

beforeAll(async () => {
  serverFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lib-int-")), "server.mjs");
  fs.writeFileSync(serverFile, SERVER_SOURCE);
  serverProc = spawn(process.execPath, [serverFile], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<string>((resolve, reject) => {
    let buf = "";
    serverProc.stdout!.on("data", (d) => {
      buf += d;
      const m = buf.match(/PORT:(\d+)/);
      if (m) resolve(m[1]!);
    });
    serverProc.on("error", reject);
    setTimeout(() => reject(new Error("server did not report a port")), 5000);
  });
  url = `http://127.0.0.1:${port}/mcp`;
});

afterAll(() => {
  serverProc?.kill();
  if (serverFile) fs.rmSync(path.dirname(serverFile), { recursive: true, force: true });
});

function realCli(overrides: Record<string, unknown> = {}) {
  return createRemoteLibrarianCli({
    mcpCallBin: binPath,
    env: { ...process.env, LIBRARIAN_MCP_URL: url, LIBRARIAN_AGENT_TOKEN: "tok_int" },
    ...overrides,
  });
}

describe("createRemoteLibrarianCli — real spawnSync path", () => {
  it("starts a session through the real bin + default runner", () => {
    const session = realCli().startSession({ harness: "claude-code", cwd: "/x", summary: "go" });
    expect(session.id).toBe("ses_int");
    expect(session.status).toBe("active");
  });

  it("lists sessions through the real bin", () => {
    const sessions = realCli().listSessions({ harness: "claude-code", cwd: "/x" });
    expect(sessions.map((s) => s.id)).toEqual(["ses_int"]);
  });

  it("maps a missing node binary to a spawn error (fail-soft)", () => {
    const cli = createRemoteLibrarianCli({
      nodeBin: "definitely-not-a-real-node-xyz",
      mcpCallBin: binPath,
      env: { ...process.env, LIBRARIAN_MCP_URL: url, LIBRARIAN_AGENT_TOKEN: "tok_int" },
    });
    const err = (() => {
      try {
        cli.startSession({ harness: "pi" });
        return null;
      } catch (e) {
        return e as LibrarianCliError;
      }
    })();
    expect(err).toBeInstanceOf(LibrarianCliError);
    expect(err?.kind).toBe("spawn");
  });

  it("maps a non-zero helper exit to an exit error (fail-soft)", () => {
    const cli = createRemoteLibrarianCli({
      mcpCallBin: path.join(here, "no-such-helper-xyz.js"),
      env: { ...process.env, LIBRARIAN_MCP_URL: url, LIBRARIAN_AGENT_TOKEN: "tok_int" },
    });
    const err = (() => {
      try {
        cli.startSession({ harness: "pi" });
        return null;
      } catch (e) {
        return e as LibrarianCliError;
      }
    })();
    expect(err).toBeInstanceOf(LibrarianCliError);
    expect(err?.kind).toBe("exit");
  });
});
