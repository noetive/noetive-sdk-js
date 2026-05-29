import { describe, expect, it, vi } from "vitest";
import {
  AuthenticationError,
  ErrorCodes,
  NoetiveError,
  ServiceUnavailableError,
  SubscribeSetupError,
  SubscribeStreamError,
  wrapAsSubscribeSetup,
} from "../../src/errors.js";
import { BackoffSchedulePolicy } from "../../src/retry.js";
import { SemantikClient } from "../../src/semantik/client.js";

function sseResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/event-stream", ...(init.headers as object) },
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers as object) },
  });
}

describe("subscribe — handshake", () => {
  it("captures subscription_id and yields match events", async () => {
    const wire =
      `event: subscribed\ndata: {"subscription_id":"sub_42"}\n\n` +
      `event: match\ndata: {"message_id":"m1","score":0.9}\n\n` +
      `event: match\ndata: {"message_id":"m2","score":0.8}\n\n`;

    const fetchMock = vi.fn(async () => sseResponse(wire)) as unknown as typeof fetch;
    const c = new SemantikClient({ apiKey: "keyu_test", fetch: fetchMock });

    const stream = await c.subscribe({ query: "*" });
    expect(stream.subscriptionId).toBe("sub_42");

    const matches: { message_id: string; score: number }[] = [];
    for await (const m of stream) matches.push(m);
    expect(matches).toEqual([
      { message_id: "m1", score: 0.9 },
      { message_id: "m2", score: 0.8 },
    ]);
  });

  it("throws SubscribeSetupError (wrapping MalformedSseError) when Content-Type is wrong", async () => {
    const fetchMock = vi.fn(
      async () => new Response("hi", { status: 200, headers: { "content-type": "text/plain" } }),
    ) as unknown as typeof fetch;
    const c = new SemantikClient({ apiKey: "keyu_test", fetch: fetchMock });
    await expect(c.subscribe({ query: "*" })).rejects.toBeInstanceOf(SubscribeSetupError);
    // And the wrapped cause carries the MalformedSseError code through.
    try {
      await c.subscribe({ query: "*" });
    } catch (e) {
      expect(e).toBeInstanceOf(NoetiveError);
      expect((e as NoetiveError).code).toBe(ErrorCodes.MalformedSse);
    }
  });

  it("throws when subscribed frame is missing", async () => {
    const wire = `event: match\ndata: {"message_id":"x","score":0.1}\n\n`;
    const fetchMock = vi.fn(async () => sseResponse(wire)) as unknown as typeof fetch;
    const c = new SemantikClient({ apiKey: "keyu_test", fetch: fetchMock });
    await expect(c.subscribe({ query: "*" })).rejects.toBeInstanceOf(SubscribeSetupError);
  });

  it("close() is idempotent", async () => {
    const wire =
      `event: subscribed\ndata: {"subscription_id":"s"}\n\n` +
      `event: match\ndata: {"message_id":"m","score":0.5}\n\n`;
    const fetchMock = vi.fn(async () => sseResponse(wire)) as unknown as typeof fetch;
    const c = new SemantikClient({ apiKey: "keyu_test", fetch: fetchMock });
    const stream = await c.subscribe({ query: "*" });
    await stream.close();
    await stream.close();
    await stream.close();
  });

  it("skips unknown event types (forward compat)", async () => {
    const wire =
      'event: subscribed\ndata: {"subscription_id":"s"}\n\n' +
      "event: heartbeat\ndata: {}\n\n" +
      'event: match\ndata: {"message_id":"m","score":0.5}\n\n';
    const fetchMock = vi.fn(async () => sseResponse(wire)) as unknown as typeof fetch;
    const c = new SemantikClient({ apiKey: "keyu_test", fetch: fetchMock });
    const stream = await c.subscribe({ query: "*" });
    const got: unknown[] = [];
    for await (const m of stream) got.push(m);
    expect(got).toEqual([{ message_id: "m", score: 0.5 }]);
  });
});

describe("A1: subscribe handshake retry", () => {
  it("A1: subscribe handshake retries on 503 with retry_after_ms", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      if (n < 3) {
        return jsonResponse(
          { error: "unavailable", message: "down", retry_after_ms: 1 },
          { status: 503 },
        );
      }
      return sseResponse(`event: subscribed\ndata: {"subscription_id":"sub_ok"}\n\n`);
    }) as unknown as typeof fetch;

    const c = new SemantikClient({
      apiKey: "keyu_test",
      fetch: fetchMock,
      retryPolicy: new BackoffSchedulePolicy({ schedule: [1, 1, 1, 1], maxAttempts: 5 }),
    });
    const stream = await c.subscribe({ query: "*" });
    expect(stream.subscriptionId).toBe("sub_ok");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await stream.close();
  });

  it("A1: subscribe surfaces immediately after subscribed frame on stream drop (no retry)", async () => {
    // Truncated `match` frame: the parser will see no terminating blank line.
    // We close the stream mid-frame so the iterator raises a SubscribeStreamError
    // and the consumer sees it. The handshake itself should run exactly once.
    const wire =
      `event: subscribed\ndata: {"subscription_id":"sub_x"}\n\n` +
      `event: match\ndata: {"message_id":`; // truncated — no closing blank line

    const fetchMock = vi.fn(async () => sseResponse(wire)) as unknown as typeof fetch;
    const c = new SemantikClient({
      apiKey: "keyu_test",
      fetch: fetchMock,
      retryPolicy: new BackoffSchedulePolicy({ schedule: [1, 1, 1, 1], maxAttempts: 5 }),
    });
    const stream = await c.subscribe({ query: "*" });
    expect(stream.subscriptionId).toBe("sub_x");

    let caught: unknown;
    try {
      for await (const _m of stream) {
        // Should not yield: the only match frame is malformed.
      }
    } catch (e) {
      caught = e;
    }
    // Truncated frame either yields nothing (stream ended cleanly without
    // emitting the malformed match) or throws SubscribeStreamError. The
    // critical invariant is that there is NO retry of the handshake.
    if (caught !== undefined) {
      expect(caught).toBeInstanceOf(SubscribeStreamError);
      expect(caught).toBeInstanceOf(NoetiveError);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("B1: setup vs stream error split", () => {
  it("B1: handshake failure produces SubscribeSetupError (instanceof NoetiveError)", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { error: "unauthorized", message: "bad token", request_id: "rid-7" },
        { status: 401, headers: { "x-request-id": "rid-7" } },
      ),
    ) as unknown as typeof fetch;

    const c = new SemantikClient({ apiKey: "keyu_test", fetch: fetchMock });
    let caught: unknown;
    try {
      await c.subscribe({ query: "*" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SubscribeSetupError);
    expect(caught).toBeInstanceOf(NoetiveError);
    const err = caught as NoetiveError;
    expect(err.code).toBe(ErrorCodes.Unauthorized);
    expect(err.httpStatus).toBe(401);
    expect(err.requestId).toBe("rid-7");
    // Cause chain points back to the original AuthenticationError.
    const cause = (err as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(AuthenticationError);
  });

  it("B1: mid-stream malformed match frame produces SubscribeStreamError", async () => {
    const wire =
      `event: subscribed\ndata: {"subscription_id":"s"}\n\n` + "event: match\ndata: not-json\n\n";
    const fetchMock = vi.fn(async () => sseResponse(wire)) as unknown as typeof fetch;
    const c = new SemantikClient({ apiKey: "keyu_test", fetch: fetchMock });
    const stream = await c.subscribe({ query: "*" });
    let caught: unknown;
    try {
      for await (const _m of stream) {
        // expect to throw before yielding anything
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SubscribeStreamError);
    expect(caught).toBeInstanceOf(NoetiveError);
    // The wrapped MalformedSseError code is preserved.
    expect((caught as NoetiveError).code).toBe(ErrorCodes.MalformedSse);
  });

  it("B1: SubscribeSetupError preserves all NoetiveError fields", () => {
    const inner = new ServiceUnavailableError("down", {
      code: ErrorCodes.Unavailable,
      httpStatus: 503,
      requestId: "rid-9",
      retryAfterMs: 2500,
      responseBody: { error: "unavailable" },
    });
    const wrapped = wrapAsSubscribeSetup(inner);
    expect(wrapped).toBeInstanceOf(SubscribeSetupError);
    expect(wrapped).toBeInstanceOf(NoetiveError);
    expect(wrapped.code).toBe(inner.code);
    expect(wrapped.message).toBe(inner.message);
    expect(wrapped.httpStatus).toBe(inner.httpStatus);
    expect(wrapped.requestId).toBe(inner.requestId);
    expect(wrapped.retryAfterMs).toBe(inner.retryAfterMs);
    expect(wrapped.responseBody).toEqual(inner.responseBody);
    expect((wrapped as { cause?: unknown }).cause).toBe(inner);
  });
});
