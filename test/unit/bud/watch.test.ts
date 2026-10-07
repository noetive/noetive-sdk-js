/**
 * The journal is served only as a stream: an `open` frame, then `batch` frames
 * and `: keepalive` comments. These tests stand up that stream and check what
 * watch and wait make of each part of it.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BudError,
  BudErrorCodes,
  type JournalEvent,
  MAX_WAIT_SECONDS,
  StreamEndedError,
  TransientRetry,
  isEmptyWait,
} from "../../../src/bud/index.js";
import { waitWindowMs } from "../../../src/bud/watch.js";
import {
  type ServerStream,
  budClient,
  eventStream,
  fakeFetch,
  refusingServer,
  sleep,
  watchServer,
} from "./server.js";

const twoEvents =
  '{"cursor":"43","events":[' +
  '{"id":"journal_01a","type":"mail.received","mailbox":"ag_01x","message":"message_01a","seq":42},' +
  '{"id":"journal_01b","type":"mail.sent","mailbox":"ag_01x","message":"message_01b","seq":43,' +
  '"data":{"message_id":"abc@example.com"}}]}';

async function collect(stream: AsyncIterable<JournalEvent>): Promise<string[]> {
  const ids: string[] = [];
  for await (const ev of stream) ids.push(ev.id);
  return ids;
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("watch", () => {
  it("reads the stream as the server writes it: open cursor, keepalive and unknown frames skipped, batch in order", async () => {
    const srv = watchServer((s) => {
      s.open("41");
      s.keepalive();
      s.frame("presence", "not json; a frame this version does not know");
      s.frame("batch", twoEvents);
    });
    const st = await budClient(srv.fetch).watch();
    expect(st.cursor()).toBe("41");
    expect(st.requestId).toBe("request_01stream");

    expect(await collect(st)).toEqual(["journal_01a", "journal_01b"]);
    expect(st.cursor()).toBe("43");
  });

  it("moves the cursor past a batch only once its last event has been taken", async () => {
    const srv = watchServer(async (s) => {
      s.open("41");
      s.frame("batch", twoEvents);
      await s.hold();
    });
    const st = await budClient(srv.fetch).watch();
    const events = st[Symbol.asyncIterator]();
    expect((await events.next()).value?.id).toBe("journal_01a");
    // Resuming here must replay journal_01b, so the cursor has not moved.
    expect(st.cursor()).toBe("41");
    expect((await events.next()).value?.id).toBe("journal_01b");
    expect(st.cursor()).toBe("43");
    await st.close();
  });

  it("commits a batch that only moves the cursor at once", async () => {
    const srv = watchServer(async (s) => {
      s.open("41");
      s.frame("batch", '{"cursor":"42"}');
      await s.hold();
    });
    const st = await budClient(srv.fetch).watch();
    const reading = collect(st);
    await sleep(50);
    expect(st.cursor()).toBe("42");
    await st.close();
    await reading;
  });

  it("ends on a refusal in flight, keeping the cursor the error frame did not carry", async () => {
    const srv = watchServer(async (s) => {
      s.open("41");
      s.frame(
        "batch",
        '{"cursor":"","error":{"code":"internal","message":"the request could not be completed"}}',
      );
      await s.hold();
    });
    const st = await budClient(srv.fetch).watch();
    const err = await caught(collect(st));
    expect(BudError.is(err, BudErrorCodes.Internal)).toBe(true);
    expect((err as BudError).requestId).toBe("request_01stream");
    // The stream was answered at 200; 0 would read as refused before sending.
    expect((err as BudError).httpStatus).toBe(200);
    expect(st.cursor()).toBe("41");
    await srv.released[0];
  });

  it("throws the server's refusal when the stream never opens", async () => {
    const srv = refusingServer(
      403,
      '{"error":{"code":"forbidden_scope","message":"this key does not reach an agent on this service"}}',
    );
    const err = await caught(budClient(srv.fetch).watch());
    expect(BudError.is(err, BudErrorCodes.ForbiddenScope)).toBe(true);
    expect((err as BudError).httpStatus).toBe(403);
    expect((err as BudError).requestId).toBe("request_01refused");
  });

  it("skips a batch that only moves the cursor", async () => {
    const srv = watchServer((s) => {
      s.open("41");
      s.frame("batch", '{"cursor":"42"}');
      s.frame("batch", '{"cursor":"43","events":[{"id":"journal_01c"}]}');
    });
    const st = await budClient(srv.fetch).watch();
    expect(await collect(st)).toEqual(["journal_01c"]);
  });

  it("ends when the caller aborts, as a failure rather than a clean close", async () => {
    const srv = watchServer((s) => {
      s.open("41");
      return s.hold();
    });
    const ctl = new AbortController();
    const st = await budClient(srv.fetch).watch({}, { signal: ctl.signal });
    setTimeout(() => ctl.abort(new Error("caller left")), 100);
    const start = Date.now();
    const err = await caught(collect(st));
    expect((err as Error).message).toBe("caller left");
    expect(Date.now() - start).toBeLessThan(2000);
    await srv.released[0];
  });

  it("releases the connection on close, and iteration then ends cleanly", async () => {
    const srv = watchServer((s) => {
      s.open("41");
      return s.hold();
    });
    const st = await budClient(srv.fetch).watch();
    const reading = collect(st);
    await sleep(20);
    await st.close();
    expect(await reading).toEqual([]);
    await srv.released[0];
  });

  it("releases the connection when the consumer breaks out of the loop", async () => {
    const srv = watchServer(async (s) => {
      s.open("41");
      s.frame("batch", twoEvents);
      await s.hold();
    });
    const st = await budClient(srv.fetch).watch();
    for await (const _ of st) break;
    await srv.released[0];
  });
});

describe("wait", () => {
  it("returns the first batch whole, with its cursor, without holding the window", async () => {
    const srv = watchServer(async (s) => {
      s.open("41");
      s.keepalive();
      s.frame("batch", twoEvents);
      s.frame("batch", '{"cursor":"44","events":[{"id":"journal_01c","type":"mail.read"}]}');
      await s.hold();
    });
    const start = Date.now();
    const out = await budClient(srv.fetch).wait({ cursor: "41" });
    expect(out.error).toBeUndefined();
    expect(out.events?.map((e) => e.id)).toEqual(["journal_01a", "journal_01b"]);
    expect(out.events?.[1]?.data.message_id).toBe("abc@example.com");
    expect(out.cursor).toBe("43");
    expect(Date.now() - start).toBeLessThan(5000);
    expect(srv.received[0]?.body).toMatchObject({ cursor: "41", mailbox: "" });
  });

  it("treats a quiet window as success at the stream's cursor, after the window and not before", async () => {
    const srv = watchServer(async (s) => {
      s.open("41");
      while (!s.isGone()) {
        await sleep(200);
        s.keepalive();
      }
    });
    const start = Date.now();
    const out = await budClient(srv.fetch).wait({ timeout_s: 1 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(3000);
    expect(isEmptyWait(out)).toBe(true);
    expect(out.cursor).toBe("41");
    await srv.released[0];
  });

  it("returns a refusal before the stream opens as a value, with the caller's cursor", async () => {
    const srv = refusingServer(
      400,
      '{"error":{"code":"invalid","message":"the cursor does not parse","field":"/cursor"}}',
    );
    const out = await budClient(srv.fetch).wait({ cursor: "not-a-cursor" });
    expect(out.error?.code).toBe(BudErrorCodes.Invalid);
    expect(out.error?.field).toBe("/cursor");
    expect(out.error?.httpStatus).toBe(400);
    expect(out.error?.requestId).toBe("request_01refused");
    expect(out.cursor).toBe("not-a-cursor");
  });

  it("returns a refusal in flight as a value, with the stream's cursor and the frame's request id", async () => {
    const srv = watchServer(async (s) => {
      s.open("41");
      s.frame(
        "batch",
        '{"cursor":"","error":{"code":"upstream_unavailable","message":"a dependency did not answer","request_id":"request_01frame"}}',
      );
      await s.hold();
    });
    const out = await budClient(srv.fetch).wait();
    expect(out.error?.code).toBe(BudErrorCodes.UpstreamUnavailable);
    expect(out.cursor).toBe("41");
    expect(out.error?.requestId).toBe("request_01frame");
    expect(out.error?.httpStatus).toBe(200);
    expect(isEmptyWait(out)).toBe(false);
    await srv.released[0];
  });

  it("keeps the refusal's own request id over the header's", async () => {
    const srv = refusingServer(
      403,
      '{"error":{"code":"forbidden_scope","message":"no mail scope","request_id":"request_01body"}}',
    );
    const out = await budClient(srv.fetch).wait();
    expect(out.error?.requestId).toBe("request_01body");
  });

  it("ends with the caller's abort, not an empty success", async () => {
    const srv = watchServer((s) => {
      s.open("41");
      return s.hold();
    });
    const start = Date.now();
    const err = await caught(
      budClient(srv.fetch).wait({ timeout_s: 5 }, { signal: AbortSignal.timeout(200) }),
    );
    expect((err as Error).name).toBe("TimeoutError");
    expect(Date.now() - start).toBeLessThan(2000);
    await srv.released[0];
  });

  it("does not read a stream that closed without a batch as a quiet window", async () => {
    const srv = watchServer((s) => s.open("41"));
    const err = await caught(budClient(srv.fetch).wait({ timeout_s: 5 }));
    expect(err).toBeInstanceOf(StreamEndedError);
  });

  it("is not cut short by a slow body", async () => {
    const srv = watchServer(async (s) => {
      s.open("41");
      await sleep(300);
      s.frame("batch", '{"cursor":"42","events":[{"id":"journal_01a"}]}');
      await s.hold();
    });
    const out = await budClient(srv.fetch, { responseTimeoutMs: 100 }).wait({ timeout_s: 3 });
    expect(out.cursor).toBe("42");
  });

  it("does not spend the window on a slow handshake", async () => {
    const srv = watchServer(
      (s) => {
        s.open("41");
        return s.hold();
      },
      { delayMs: 1200 },
    );
    const out = await budClient(srv.fetch).wait({ timeout_s: 1 });
    expect(isEmptyWait(out)).toBe(true);
    expect(out.cursor).toBe("41");
  });

  it("releases its connection before returning", async () => {
    const srv = watchServer(async (s) => {
      s.open("41");
      s.frame("batch", twoEvents);
      await s.hold();
    });
    await budClient(srv.fetch).wait({ timeout_s: 5 });
    const released = await Promise.race([
      srv.released[0]?.then(() => true),
      sleep(1000).then(() => false),
    ]);
    expect(released).toBe(true);
  });

  it("returns an empty batch's advanced cursor when the window closes", async () => {
    const srv = watchServer(async (s) => {
      s.open("41");
      s.frame("batch", '{"cursor":"42"}');
      await s.hold();
    });
    const start = Date.now();
    const out = await budClient(srv.fetch).wait({ timeout_s: 1 });
    expect(isEmptyWait(out)).toBe(true);
    expect(out.cursor).toBe("42");
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
  });

  it("returns a batch larger than the default frame bound whole", async () => {
    const subject = "\\u003c".repeat(120);
    const events = Array.from(
      { length: 100 },
      (_, i) =>
        `{"id":"journal_${String(i).padStart(3, "0")}","type":"mail.received","data":{"subject":"${subject}","from":"${subject}"}}`,
    );
    const batch = `{"cursor":"141","events":[${events.join(",")}]}`;
    expect(batch.length).toBeGreaterThan(128 * 1024);

    const srv = watchServer(async (s) => {
      s.open("41");
      s.frame("batch", batch);
      await s.hold();
    });
    const out = await budClient(srv.fetch).wait();
    expect(out.events).toHaveLength(100);
    expect(out.cursor).toBe("141");
  });

  it("reports a frame over 4 MiB as malformed, naming the stream", async () => {
    const srv = watchServer(async (s) => {
      s.open("41");
      s.frame("batch", `{"cursor":"42","pad":"${"x".repeat(5 * 1024 * 1024)}"}`);
      await s.hold();
    });
    const err = await caught(budClient(srv.fetch).wait({ timeout_s: 5 }));
    expect(BudError.is(err, BudErrorCodes.MalformedResponse)).toBe(true);
    expect((err as BudError).requestId).toBe("request_01stream");
    expect((err as BudError).httpStatus).toBe(200);
  });
});

describe("a malformed stream is not an answer", () => {
  const scripts: Record<string, (s: ServerStream) => void> = {
    "no open frame": (s) => s.frame("batch", twoEvents),
    "an open that is not JSON": (s) => s.frame("open", "41"),
    "a batch that is not JSON": (s) => {
      s.open("41");
      s.frame("batch", "{events");
    },
    "a batch whose events are not a list": (s) => {
      s.open("41");
      s.frame("batch", '{"cursor":"42","events":{}}');
    },
  };
  for (const [name, script] of Object.entries(scripts)) {
    it(name, async () => {
      const srv = watchServer(script);
      const err = await caught(budClient(srv.fetch).wait({ timeout_s: 5 }));
      expect(BudError.is(err, BudErrorCodes.MalformedResponse)).toBe(true);
      expect((err as BudError).httpStatus).toBe(200);
    });
  }

  it("a 200 that is not an event stream", async () => {
    const srv = fakeFetch(
      () =>
        new Response('{"cursor":"41"}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const err = await caught(budClient(srv.fetch).watch());
    expect(BudError.is(err, BudErrorCodes.MalformedResponse)).toBe(true);
  });

  it("JSON that is not an envelope, at a failing status", async () => {
    const srv = refusingServer(500, '{"cursor":"41"}');
    const err = await caught(budClient(srv.fetch).watch());
    expect(BudError.is(err, BudErrorCodes.MalformedResponse)).toBe(true);
  });

  it("a gateway's page is not the server's refusal", async () => {
    const srv = refusingServer(502, "<html>502 Bad Gateway</html>");
    const err = await caught(budClient(srv.fetch).wait());
    expect(BudError.is(err, BudErrorCodes.MalformedResponse)).toBe(true);
    expect((err as BudError).httpStatus).toBe(502);
  });
});

describe("the handshake is retried only when the connection failed", () => {
  const policy = new TransientRetry({ attempts: 1, backoffMs: [1] });

  it("retries a dropped connection once", async () => {
    const srv = watchServer(async (s) => {
      s.open("41");
      s.frame("batch", twoEvents);
      await s.hold();
    });
    let calls = 0;
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      if (calls === 1) throw new TypeError("connection reset before any response");
      return srv.fetch(input, init);
    }) as typeof fetch;
    const out = await budClient(flaky, { retry: policy }).wait();
    expect(out.events).toHaveLength(2);
    expect(calls).toBe(2);
  });

  it("gives up after the policy's one retry", async () => {
    let calls = 0;
    const down = (async () => {
      calls++;
      throw new TypeError("connection refused");
    }) as typeof fetch;
    const err = await caught(budClient(down, { retry: policy }).wait());
    expect((err as Error).message).toBe("connection refused");
    expect(calls).toBe(2);
  });

  it("never retries a refusal", async () => {
    const srv = refusingServer(
      503,
      '{"error":{"code":"upstream_unavailable","message":"a dependency did not answer"}}',
    );
    const out = await budClient(srv.fetch, { retry: policy }).wait();
    expect(out.error?.code).toBe(BudErrorCodes.UpstreamUnavailable);
    expect(srv.received).toHaveLength(1);
  });

  it("a stream that does not open is a setup failure, not a stream that yields nothing", async () => {
    const srv = fakeFetch((_req, signal) => {
      const { body } = eventStream(() => {}, signal);
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });
    const err = await caught(budClient(srv.fetch).watch());
    expect(BudError.is(err, BudErrorCodes.MalformedResponse)).toBe(true);
  });
});

describe("the wait window", () => {
  it("is bounded to [1, MAX_WAIT_SECONDS] and defaults to the maximum", () => {
    const max = MAX_WAIT_SECONDS * 1000;
    const cases: [number | undefined, number][] = [
      [undefined, max],
      [-1, max],
      [0, max],
      [1, 1000],
      [MAX_WAIT_SECONDS - 1, max - 1000],
      [MAX_WAIT_SECONDS, max],
      [MAX_WAIT_SECONDS + 1, max],
      [0.5, 1000],
      [Number.NaN, max],
    ];
    for (const [seconds, want] of cases) expect(waitWindowMs(seconds)).toBe(want);
  });

  it("never falls outside the bound for any input", () => {
    fc.assert(
      fc.property(fc.double(), (s) => {
        const ms = waitWindowMs(s);
        return ms >= 1000 && ms <= MAX_WAIT_SECONDS * 1000;
      }),
    );
  });
});

describe("a server null on the stream", () => {
  it("is left out of a batch and its events", async () => {
    const srv = watchServer(async (s) => {
      s.open("41");
      s.frame("batch", '{"cursor":"42","events":null,"error":null}');
      s.frame(
        "batch",
        '{"cursor":"43","events":[{"id":"journal_01a","corr":null,"data":{"from":null}}]}',
      );
      await s.hold();
    });
    const out = await budClient(srv.fetch).wait();
    expect(out.cursor).toBe("43");
    expect(out.events?.[0]).not.toHaveProperty("corr");
    expect(out.events?.[0]?.data).not.toHaveProperty("from");
  });
});
