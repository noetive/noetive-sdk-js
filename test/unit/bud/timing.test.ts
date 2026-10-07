/**
 * The response budget and the caller's abort, with a short injected budget so
 * the 45-second default is exercised in milliseconds.
 */

import { describe, expect, it } from "vitest";
import { BudError, BudErrorCodes } from "../../../src/bud/index.js";
import { budClient, fakeFetch, sleep, watchServer } from "./server.js";

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

/** A body that sends `first`, then nothing, and ignores every signal: only the client can end it. */
function stalledBody(first: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(first));
    },
  });
}

describe("the response budget", () => {
  it("cuts a request whose response never begins", async () => {
    const srv = fakeFetch(() => new Promise<Response>(() => {}));
    const start = Date.now();
    const err = await caught(budClient(srv.fetch, { responseTimeoutMs: 50 }).describeMe());
    expect((err as Error).message).toMatch(/no response within 50ms/);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("cuts a stream that sent headers and never its opening frame", async () => {
    const srv = watchServer((s) => s.hold());
    const start = Date.now();
    const err = await caught(
      budClient(srv.fetch, { responseTimeoutMs: 100 }).wait({ timeout_s: 5 }),
    );
    expect((err as Error).message).toMatch(/no response within 100ms/);
    expect(Date.now() - start).toBeLessThan(2000);
    await srv.released[0];
  });

  it("does not cut a unary body that is slower than the budget once headers arrived", async () => {
    const srv = fakeFetch(() => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          await sleep(200);
          controller.enqueue(new TextEncoder().encode('{"ref":"me","kind":"me"}'));
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    });
    const out = await budClient(srv.fetch, { responseTimeoutMs: 50 }).describeMe();
    expect(out.kind).toBe("me");
  });
});

describe("the caller's abort while a body is read", () => {
  it("ends a refused handshake's body read with the signal's reason", async () => {
    const srv = fakeFetch(
      () =>
        new Response(stalledBody('{"error":'), { status: 403, headers: { "X-Request-Id": "r" } }),
    );
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(new Error("caller left")), 50);
    const err = await caught(budClient(srv.fetch).wait({}, { signal: ctl.signal }));
    expect((err as Error).message).toBe("caller left");
    expect(BudError.is(err, BudErrorCodes.MalformedResponse)).toBe(false);
  });

  it("ends a unary body read with the signal's reason", async () => {
    const srv = fakeFetch(() => new Response(stalledBody('{"ref":'), { status: 200 }));
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(new Error("caller left")), 50);
    const err = await caught(budClient(srv.fetch).describeMe({ signal: ctl.signal }));
    expect((err as Error).message).toBe("caller left");
  });
});
