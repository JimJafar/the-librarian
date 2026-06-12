// A tiny real node:http server for transport-level tests (the same approach
// the standalone plugin repos use): the client under test talks to a live
// localhost socket, so redirect / size-cap / auth behaviour is exercised
// against actual HTTP, not a mocked fetch.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface FakeServer {
  /** Base URL, e.g. `http://127.0.0.1:54321` (no trailing slash). */
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export type FakeHandler = (req: RecordedRequest, res: ServerResponse, raw: IncomingMessage) => void;

export async function startFakeServer(handler: FakeHandler): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const recorded: RecordedRequest = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body,
      };
      requests.push(recorded);
      handler(recorded, res, req);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake server did not bind to a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** A standard MCP `tools/call` success envelope. */
export function mcpTextEnvelope(text: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text }] },
  });
}
