/**
 * What a caller sees, and the one distinction the client turns on: a refusal is
 * a value, a transport failure is thrown.
 */

import { inspect } from "node:util";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BudClient,
  BudError,
  BudErrorCodes,
  NoRetry,
  type RetryPolicy,
  SendState,
  TransientRetry,
  served,
} from "../../../src/bud/index.js";
import { answer, budClient, fakeFetch, refusingServer } from "./server.js";

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("a refusal is a value", () => {
  it("comes back on the output with its status, the header's request id and what to do next", async () => {
    const srv = fakeFetch(() =>
      answer(
        '{"ref":"message_01x","error":{"code":"precondition_failed",' +
          '"message":"other writes to this object kept landing first","hint":"read it and try again"}}',
        409,
        "request_01abc",
      ),
    );
    const out = await budClient(srv.fetch).updateMessage({
      id: "message_01x",
      changes: { labels: ["urgent"] },
    });
    expect(out.error).toBeInstanceOf(BudError);
    expect(out.error?.code).toBe(BudErrorCodes.PreconditionFailed);
    expect(out.error?.httpStatus).toBe(409);
    expect(out.error?.requestId).toBe("request_01abc");
    expect(out.error?.hint).toBe("read it and try again");
    expect(out.error?.retryable()).toBe(true);
    expect(out.ref).toBe("message_01x");
  });

  it("carries a refusal on the health probe and the catalog too", async () => {
    const srv = refusingServer(
      403,
      '{"error":{"code":"forbidden_scope","message":"this key does not reach an agent on this service"}}',
    );
    const c = budClient(srv.fetch);
    for (const out of [await c.health(), await c.describeCatalog()]) {
      expect(out.error?.code).toBe(BudErrorCodes.ForbiddenScope);
      expect(out.error?.httpStatus).toBe(403);
      expect(out.error?.requestId).toBe("request_01refused");
    }
  });

  it("matches its own code and only that", async () => {
    const srv = refusingServer(
      402,
      '{"error":{"code":"not_billable","message":"this account cannot incur usage"}}',
    );
    const out = await budClient(srv.fetch).describeMe();
    expect(BudError.is(out.error, BudErrorCodes.NotBillable)).toBe(true);
    expect(BudError.is(out.error, BudErrorCodes.UpstreamUnavailable)).toBe(false);
  });

  it("serialises back to the wire shape, so a relay can forward the output as sent", async () => {
    const body =
      '{"ref":"message_01x","error":{"code":"rate_limited","message":"spent","counter":"per_hour","retry_after_ms":1000,"request_id":"request_01b"}}';
    const out = await budClient(refusingServer(429, body).fetch).describeMessage({
      id: "message_01x",
    });
    expect(JSON.parse(JSON.stringify(out))).toEqual(JSON.parse(body));
  });
});

describe("what is not an envelope is thrown", () => {
  it("a gateway's HTML is malformed_response, keeping the status", async () => {
    const srv = fakeFetch(
      () => new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 }),
    );
    const err = await caught(budClient(srv.fetch).describeMe());
    expect(BudError.is(err, BudErrorCodes.MalformedResponse)).toBe(true);
    expect((err as BudError).httpStatus).toBe(502);
    expect((err as BudError).hint).toContain("502 Bad Gateway");
  });

  it("an empty 401 is unauthorized", async () => {
    const srv = fakeFetch(() => new Response("", { status: 401 }));
    const err = await caught(budClient(srv.fetch).describeMe());
    expect(BudError.is(err, BudErrorCodes.Unauthorized)).toBe(true);
    expect((err as BudError).httpStatus).toBe(401);
  });

  it("a success body at a failing status cannot be believed", async () => {
    const srv = fakeFetch(() => answer('{"ref":"me","kind":"me"}', 500));
    const err = await caught(budClient(srv.fetch).describeMe());
    expect(BudError.is(err, BudErrorCodes.MalformedResponse)).toBe(true);
  });

  it("an error that is not a refusal is not presented as one", async () => {
    const srv = fakeFetch(() => answer('{"error":"boom"}', 500));
    const err = await caught(budClient(srv.fetch).describeMe());
    expect(BudError.is(err, BudErrorCodes.MalformedResponse)).toBe(true);
  });

  it("a body over 32 MiB is cut and reported as malformed", async () => {
    const huge = `{"text":"${"x".repeat(33 * 1024 * 1024)}"}`;
    const srv = fakeFetch(() => answer(huge));
    const err = await caught(budClient(srv.fetch).describeMe());
    expect(BudError.is(err, BudErrorCodes.MalformedResponse)).toBe(true);
  });

  it("a failed connection is thrown as fetch threw it", async () => {
    const boom = new TypeError("fetch failed");
    const down = (async () => {
      throw boom;
    }) as typeof fetch;
    expect(await caught(budClient(down).describeMe())).toBe(boom);
  });

  it("any body yields a value or a BudError, never anything else", async () => {
    // 204, 205 and 304 cannot carry a body, and 3xx redirects are refused before decoding.
    const statusWithBody = fc
      .integer({ min: 200, max: 599 })
      .filter((s) => ![204, 205, 304, 301, 302, 303, 307, 308].includes(s));
    await fc.assert(
      fc.asyncProperty(fc.string(), statusWithBody, async (body, status) => {
        const srv = fakeFetch(() => new Response(body, { status }));
        try {
          const out = await budClient(srv.fetch).describeMe();
          return status < 300 || out.error instanceof BudError;
        } catch (err) {
          return err instanceof BudError && err.httpStatus === status;
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("preflight refuses before sending", () => {
  const cases: [string, (c: BudClient) => Promise<unknown>][] = [
    ["a thread id for describeMessage", (c) => c.describeMessage({ id: "thread_01x" })],
    ["a send with nothing to send", (c) => c.send({})],
    ["an update with no changes", (c) => c.updateMessage({ id: "message_01x" } as never)],
    ["a part read that names no part", (c) => c.describePart({ id: "message_01x" })],
    ["a part read aimed at a thread", (c) => c.describePart({ id: "thread_01x", part: "2" })],
    ["a message id for describeMailbox", (c) => c.describeMailbox({ id: "message_01x" })],
    ["a correspondent listing with no mailbox", (c) => c.listCorrespondents({ in: "" })],
    ["a thread id as a mailbox", (c) => c.listFolder({ in: "thread_01x" })],
    ["a message id for describeThread", (c) => c.describeThread({ id: "message_01x" })],
  ];
  for (const [name, call] of cases) {
    it(name, async () => {
      const srv = fakeFetch(() => answer("{}"));
      const err = await caught(call(budClient(srv.fetch)));
      expect(BudError.is(err, BudErrorCodes.Invalid)).toBe(true);
      expect((err as BudError).httpStatus).toBe(0);
      expect(srv.received).toHaveLength(0);
    });
  }

  it("names the prefix that arrived without quoting the whole identifier", async () => {
    const err = await caught(
      budClient(fakeFetch(() => answer("{}")).fetch).describeMessage({ id: "thread_01secret" }),
    );
    expect((err as BudError).message).toContain('"message_"');
    expect((err as BudError).message).toContain('"thread_"');
    expect((err as BudError).message).not.toContain("01secret");
  });

  it("accepts a send addressed only by cc, by bcc, or as a reply", async () => {
    const srv = fakeFetch(() => answer('{"message":"message_01x","state":"queued"}'));
    const c = budClient(srv.fetch);
    for (const input of [
      { cc: ["ada@example.com"], text: "hi" },
      { bcc: ["ada@example.com"], text: "hi" },
      { in_reply_to: "message_01p", text: "hi" },
    ]) {
      const out = await c.send(input);
      expect(out.state).toBe(SendState.Queued);
    }
    // `to` is always on the wire, as the server's document always carries it.
    expect(srv.received[0]?.body).toEqual({ to: [], cc: ["ada@example.com"], text: "hi" });
  });
});

describe("the requests carry the fields that select them", () => {
  it("each operation reaches its path with its wire names, and leaves zero values out", async () => {
    const srv = fakeFetch(() => answer("{}"));
    const c = budClient(srv.fetch);
    await c.describePart({ id: "message_01x", part: "2", mode: "text" });
    await c.describeThread({ id: "thread_01x", max_messages: 5 });
    await c.listCorrespondents({ in: "ag_01x", limit: 10, cursor: "" });
    await c.updateMessage({ id: "message_01x", changes: { read: true }, idempotency_key: "k" });
    await c.describeMe();
    await c.health();
    await c.describeCatalog();
    await c.listFolder({ in: "ag_01x", unread: false, folder: "sent" });
    await c.describeMessage({ id: "message_01x", render: "parts" });
    await c.describeMailbox({ id: "ag_01x" });
    await c.send({ to: ["a@b.example"], idempotency_key: "s1" });

    expect(srv.received.map((r) => [r.path, r.body])).toEqual([
      ["/v1/part.describe", { id: "message_01x", part: "2", mode: "text" }],
      ["/v1/thread.describe", { id: "thread_01x", max_messages: 5 }],
      ["/v1/correspondent.list", { in: "ag_01x", limit: 10 }],
      ["/v1/message.update", { id: "message_01x", changes: { read: true }, idempotency_key: "k" }],
      ["/v1/me.describe", {}],
      ["/v1/health", {}],
      ["/v1/catalog.describe", {}],
      ["/v1/folder.list", { in: "ag_01x", folder: "sent" }],
      ["/v1/message.describe", { id: "message_01x", render: "parts" }],
      ["/v1/mailbox.describe", { id: "ag_01x" }],
      ["/v1/send", { to: ["a@b.example"], idempotency_key: "s1" }],
    ]);
    for (const r of srv.received) {
      expect(r.method).toBe("POST");
      expect(r.headers.get("Content-Type")).toBe("application/json");
      expect(r.headers.get("Authorization")).toBe("Bearer test-token");
      expect(r.headers.get("User-Agent")).toMatch(/^noetive-sdk-js\//);
      expect(r.redirect).toBe("manual");
    }
  });

  it("a watch sends agent_part when it is false, because false is a filter", async () => {
    const srv = refusingServer(400, '{"error":{"code":"invalid","message":"x"}}');
    await budClient(srv.fetch).wait({ agent_part: false, types: [] });
    expect(srv.received[0]?.body).toEqual({ mailbox: "", agent_part: false });
  });
});

describe("retries", () => {
  function counting(): { fetch: typeof fetch; calls: () => number } {
    let n = 0;
    return {
      fetch: (async () => {
        n++;
        throw new TypeError("connection reset");
      }) as typeof fetch,
      calls: () => n,
    };
  }
  const generous = new TransientRetry({ attempts: 5, backoffMs: [1] });

  it("never retries an unkeyed write, however generous the policy", async () => {
    const down = counting();
    await caught(budClient(down.fetch, { retry: generous }).send({ to: ["a@b.example"] }));
    expect(down.calls()).toBe(1);
  });

  it("retries a keyed write", async () => {
    const down = counting();
    await caught(
      budClient(down.fetch, { retry: generous }).send({
        to: ["a@b.example"],
        idempotency_key: "k1",
      }),
    );
    expect(down.calls()).toBe(6);
  });

  it("retries a read", async () => {
    const down = counting();
    await caught(budClient(down.fetch, { retry: generous }).describeMe());
    expect(down.calls()).toBe(6);
  });

  it("defaults to one retry", async () => {
    const down = counting();
    const c = new BudClient({ apiKey: "k", baseUrl: "https://bud.test", fetch: down.fetch });
    await caught(c.describeMe());
    expect(down.calls()).toBe(2);
  });

  it("issues once under NoRetry", async () => {
    const down = counting();
    await caught(budClient(down.fetch, { retry: new NoRetry() }).describeMe());
    expect(down.calls()).toBe(1);
  });

  it("does not retry once a response arrived, even an unreadable one", async () => {
    const srv = fakeFetch(() => new Response("<html>", { status: 502 }));
    await caught(budClient(srv.fetch, { retry: generous }).describeMe());
    expect(srv.received).toHaveLength(1);
  });

  it("a policy that always says retry still attempts an unkeyed send exactly once", async () => {
    let waits = 0;
    const always: RetryPolicy = {
      shouldRetry: () => true,
      wait: async () => {
        // A broken gate would loop for ever; end it so the failure is a count, not a hang.
        if (++waits > 3) throw new Error("the gate let an unkeyed send through");
      },
    };
    const down = counting();
    await caught(budClient(down.fetch, { retry: always }).send({ to: ["a@b.example"] }));
    expect(down.calls()).toBe(1);
    expect(waits).toBe(0);
  });

  it("does not retry when the response arrived and its body failed mid-read", async () => {
    let calls = 0;
    const torn = (async () => {
      calls++;
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new TextEncoder().encode('{"ref":"me",'));
          } else {
            controller.error(new TypeError("connection reset mid-body"));
          }
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const err = await caught(budClient(torn, { retry: generous }).describeMe());
    expect((err as Error).message).toBe("connection reset mid-body");
    expect(calls).toBe(1);
  });

  it("a custom policy that says yes to everything cannot make any unkeyed write repeatable", async () => {
    // Yes to every op and input, for three retries — it never looks at the key.
    const yes: RetryPolicy = { shouldRetry: (attempt) => attempt < 3, wait: async () => {} };
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("send", "message.update"),
        fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
        async (op, key) => {
          const down = counting();
          const c = budClient(down.fetch, { retry: yes });
          await caught(
            op === "send"
              ? c.send({ to: ["a@b.example"], idempotency_key: key })
              : c.updateMessage({
                  id: "message_01x",
                  changes: { read: true },
                  idempotency_key: key,
                }),
          );
          return down.calls() === (key === undefined ? 1 : 4);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("an abort during backoff ends the call with the caller's reason", async () => {
    const down = counting();
    const ctl = new AbortController();
    const slow = new TransientRetry({ attempts: 3, backoffMs: [10_000] });
    const p = budClient(down.fetch, { retry: slow }).describeMe({ signal: ctl.signal });
    setTimeout(() => ctl.abort(new Error("caller left")), 20);
    expect(((await caught(p)) as Error).message).toBe("caller left");
    expect(down.calls()).toBe(1);
  });
});

describe("credentials", () => {
  it("a forwarding client sends each call's credential and holds none", async () => {
    const srv = fakeFetch(() => answer('{"ref":"me","kind":"me"}'));
    const c = BudClient.forwarding({ baseUrl: "https://bud.test", fetch: srv.fetch });
    await c.describeMe({ authorization: "Bearer one" });
    await c.describeMe({ authorization: "Bearer two" });
    await c.describeMe();
    expect(srv.received.map((r) => r.headers.get("Authorization"))).toEqual([
      "Bearer one",
      "Bearer two",
      null,
    ]);
  });

  it("a keyed client refuses a per-call credential rather than silently ignoring it", async () => {
    const srv = fakeFetch(() => answer("{}"));
    const err = await caught(budClient(srv.fetch).describeMe({ authorization: "Bearer other" }));
    expect(BudError.is(err, BudErrorCodes.Invalid)).toBe(true);
    expect(srv.received).toHaveLength(0);
  });

  it("a client never prints its credential", () => {
    const c = new BudClient({ apiKey: "keya_secret", fetch: fakeFetch(() => answer("{}")).fetch });
    expect(String(c)).not.toContain("keya_secret");
    expect(inspect(c)).not.toContain("keya_secret");
    expect(JSON.stringify(c)).not.toContain("keya_secret");
    expect(JSON.stringify({ nested: [c] })).not.toContain("keya_secret");
    expect(Object.values(c).map(String).join(" ")).not.toContain("keya_secret");
  });

  it("a blank key is refused", () => {
    expect(() => new BudClient({ apiKey: "  " })).toThrow(BudError);
  });

  it("a redirect is refused rather than followed", async () => {
    const srv = fakeFetch(
      () => new Response(null, { status: 307, headers: { Location: "https://elsewhere.test/x" } }),
    );
    // A generous policy, to prove a redirect is an answer and not a failed connection.
    const generous = new TransientRetry({ attempts: 5, backoffMs: [1] });
    const err = await caught(budClient(srv.fetch, { retry: generous }).describeMe());
    expect((err as Error).message).toContain("elsewhere.test");
    expect(srv.received).toHaveLength(1);
  });

  it("a redirect on the watch handshake is not retried either", async () => {
    const srv = fakeFetch(
      () => new Response(null, { status: 302, headers: { Location: "https://elsewhere.test/x" } }),
    );
    const generous = new TransientRetry({ attempts: 5, backoffMs: [1] });
    await caught(budClient(srv.fetch, { retry: generous }).wait());
    expect(srv.received).toHaveLength(1);
  });
});

describe("fromEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads the one Noetive key and Bud's own base URL", async () => {
    vi.stubEnv("NOETIVE_KEY_SECRET", "keya_test");
    vi.stubEnv("NOETIVE_BUD_BASE_URL", "https://bud.env.test");
    const srv = fakeFetch(() => answer('{"contract":"bud/v1"}'));
    const h = await BudClient.fromEnv({ fetch: srv.fetch, retry: new NoRetry() }).health();
    expect(h.contract).toBe("bud/v1");
    expect(srv.received[0]?.headers.get("Authorization")).toBe("Bearer keya_test");
    expect(srv.received[0]?.url).toBe("https://bud.env.test/v1/health");
  });

  it("lets an explicit base URL win over the environment", async () => {
    vi.stubEnv("NOETIVE_KEY_SECRET", "keya_test");
    vi.stubEnv("NOETIVE_BUD_BASE_URL", "https://bud.env.test");
    const srv = fakeFetch(() => answer("{}"));
    await BudClient.fromEnv({ fetch: srv.fetch, baseUrl: "https://bud.arg.test/" }).health();
    expect(srv.received[0]?.url).toBe("https://bud.arg.test/v1/health");
  });

  it("names the shared key when it is unset, and reads no product-prefixed one", () => {
    vi.stubEnv("NOETIVE_KEY_SECRET", "");
    vi.stubEnv("NOETIVE_BUD_KEY_SECRET", "keya_old");
    const err = (() => {
      try {
        BudClient.fromEnv();
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(BudError.is(err, BudErrorCodes.Invalid)).toBe(true);
    expect((err as BudError).message).toContain("NOETIVE_KEY_SECRET");
  });

  it("refuses an unexpanded placeholder", () => {
    vi.stubEnv("NOETIVE_KEY_SECRET", "${NOETIVE_KEY_SECRET}");
    expect(() => BudClient.fromEnv()).toThrow(/placeholder/);
  });
});

describe("the catalog", () => {
  it("answers by an operation's name or its path, as the server lists both", async () => {
    const srv = fakeFetch(() =>
      answer(
        '{"contract":"bud/v1","operations":[' +
          '{"name":"ListFolder","path":"folder.list","served":true},' +
          '{"name":"Send","path":"send","served":true},' +
          '{"name":"DescribeHold","path":"hold.describe","served":false}],"kinds":[]}',
      ),
    );
    const cat = await budClient(srv.fetch).describeCatalog();
    for (const op of ["ListFolder", "folder.list", "Send", "send"]) {
      expect(served(cat, op), op).toBe(true);
    }
    for (const op of ["DescribeHold", "hold.describe", "nothing.at.all"]) {
      expect(served(cat, op), op).toBe(false);
    }
  });
});
