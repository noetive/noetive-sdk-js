/**
 * The behaviours that depend on the runtime's own fetch rather than on what
 * this SDK does with a response: that a redirect is not followed with the
 * credential, and that a finished wait lets go of a real connection. Against a
 * local node:http server, so nothing leaves the machine.
 */

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BudClient, NoRetry } from "../../../src/bud/index.js";

type Handle = (req: IncomingMessage, res: ServerResponse) => void;

const servers: Server[] = [];

async function serve(handle: Handle): Promise<string> {
  const server = createServer(handle);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
});

function client(baseUrl: string): BudClient {
  return new BudClient({ apiKey: "test-token", baseUrl, retry: new NoRetry() });
}

describe("over a real connection", () => {
  it("refuses a redirect, so the credential never reaches another host", async () => {
    let elsewhere = 0;
    const other = await serve((req, res) => {
      if (req.headers.authorization) elsewhere++;
      res.end("{}");
    });
    const base = await serve((_req, res) => {
      res.writeHead(307, { Location: `${other}/v1/me.describe` }).end();
    });
    await expect(client(base).describeMe()).rejects.toThrow(/redirect/);
    expect(elsewhere).toBe(0);
  });

  it("lets go of the stream when a wait returns", async () => {
    let released!: () => void;
    const gone = new Promise<void>((resolve) => {
      released = resolve;
    });
    const base = await serve((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('event: open\ndata: {"cursor":"41"}\n\n');
      res.write('event: batch\ndata: {"cursor":"42","events":[{"id":"journal_01a"}]}\n\n');
      req.socket.on("close", released);
    });
    const out = await client(base).wait({ timeout_s: 5 });
    expect(out.cursor).toBe("42");
    const closed = await Promise.race([
      gone.then(() => true),
      new Promise((r) => setTimeout(() => r(false), 1000)),
    ]);
    expect(closed).toBe(true);
  });
});
