// Regression: a misbehaving client must NEVER crash the server. `createHttpServer`
// now guards `req`/`res`/`clientError`/connection-socket errors — pre-fix, an EPIPE
// on a response write to a vanished client was an UNHANDLED 'error' that killed the
// whole process (and intermittently crashed the parallel test run under the JSON
// reporter). This drives real sockets at a spawned server and asserts it survives.
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

/**
 * Open a raw TCP socket, write something (often malformed or a request we abandon),
 * then RST it shortly after — exactly the "client vanished mid-exchange" shape.
 * Resolves on close; our own socket errors are expected and swallowed.
 */
function abuse(host: string, port: number, write: (s: net.Socket) => void): Promise<void> {
  return new Promise((resolve) => {
    const sock = net.connect(port, host, () => {
      try {
        write(sock);
      } catch {
        /* deliberately misbehaving */
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => resolve());
    setTimeout(() => sock.destroy(), 15);
  });
}

describe("server survives misbehaving clients (no crash on disconnect/garbage)", () => {
  let dataDir: string | undefined;
  let server: Awaited<ReturnType<typeof startHttpServer>> | undefined;

  afterEach(async () => {
    if (server) await server.stop();
    if (dataDir) cleanupTempDir(dataDir);
    server = undefined;
    dataDir = undefined;
  });

  it("stays up after malformed requests and mid-request disconnects", async () => {
    dataDir = makeTempDir();
    server = await startHttpServer({ dataDir, token: "http-token" });
    const u = new URL(server.url);
    const host = u.hostname;
    const port = Number(u.port);

    // 1) A garbage request line → 'clientError'.
    await abuse(host, port, (s) => s.write("GARBAGE \r\nHost: x\r\n\r\n"));
    // 2) Valid request header, then RST without reading the response → the server's
    //    response write races a vanished client (the res/socket EPIPE path).
    for (let i = 0; i < 16; i++) {
      await abuse(host, port, (s) => s.write(`GET /healthz HTTP/1.1\r\nHost: ${host}\r\n\r\n`));
    }

    // The invariant: the server is still alive and serving normal traffic.
    const res = await fetch(`${server.url}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe("ok");
  });
});
