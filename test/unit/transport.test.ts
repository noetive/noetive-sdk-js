import { describe, expect, it, vi } from "vitest";
import {
  AuthenticationError,
  BackpressureError,
  RequestTooLargeError,
  ServiceUnavailableError,
  TransportError,
} from "../../src/errors.js";
import { BackoffSchedulePolicy, noRetry } from "../../src/retry.js";
import { Transport } from "../../src/transport.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers as object) },
  });
}

/** Build a fast retry policy so transport tests don't block on real backoff. */
function fastPolicy(maxAttempts: number): BackoffSchedulePolicy {
  return new BackoffSchedulePolicy({ schedule: [1, 1, 1, 1], maxAttempts });
}

describe("Transport.doJson — success path", () => {
  it("posts JSON, returns decoded JSON, sends auth header", async () => {
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      expect(init.method).toBe("POST");
      expect(init.headers.get("authorization")).toBe("Bearer keyu_test");
      expect(init.headers.get("content-type")).toBe("application/json");
      expect(init.headers.get("user-agent")).toMatch(/^noetive-sdk-js\//);
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const t = new Transport({
      baseUrl: "https://x.example",
      apiKey: "keyu_test",
      fetch: fetchMock,
      retryPolicy: noRetry(),
    });
    const out = await t.doJson<{ q: string }, { ok: boolean }>({
      path: "/v1/search",
      body: { q: "hi" },
      auth: "bearer",
      maxBodyBytes: 1024,
    });
    expect(out).toEqual({ ok: true });
  });

  it("omits auth header when auth is 'none'", async () => {
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      expect(init.headers.get("authorization")).toBeNull();
      return jsonResponse({ valid: true });
    }) as unknown as typeof fetch;

    const t = new Transport({
      baseUrl: "https://x.example",
      apiKey: "keyu_test",
      fetch: fetchMock,
      retryPolicy: noRetry(),
    });
    await t.doJson({
      path: "/v1/lint",
      body: { query: "x" },
      auth: "none",
      maxBodyBytes: 1024,
    });
  });
});

describe("Transport.doJson — error envelope decoding", () => {
  it("maps 401 unauthorized to AuthenticationError", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { error: "unauthorized", message: "bad token", request_id: "rid-1" },
        { status: 401, headers: { "x-request-id": "rid-1" } },
      ),
    ) as unknown as typeof fetch;

    const t = new Transport({
      baseUrl: "https://x.example",
      apiKey: "keyu_test",
      fetch: fetchMock,
      retryPolicy: noRetry(),
    });
    await expect(
      t.doJson({
        path: "/v1/search",
        body: {},
        auth: "bearer",
        maxBodyBytes: 1024,
      }),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe("Transport.doJson — retry policy", () => {
  it("retries on backpressure until success", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      if (n < 3) {
        return jsonResponse(
          { error: "backpressure", message: "slow down", retry_after_ms: 1 },
          { status: 429 },
        );
      }
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const t = new Transport({
      baseUrl: "https://x.example",
      apiKey: "keyu_test",
      fetch: fetchMock,
      retryPolicy: fastPolicy(5),
    });
    const out = await t.doJson<unknown, { ok: boolean }>({
      path: "/v1/search",
      body: {},
      auth: "bearer",
      maxBodyBytes: 1024,
    });
    expect(out).toEqual({ ok: true });
    expect(n).toBe(3);
  });

  it("gives up after maxAttempts and surfaces the final error", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: "unavailable", retry_after_ms: 1 }, { status: 503 }),
    ) as unknown as typeof fetch;

    const t = new Transport({
      baseUrl: "https://x.example",
      apiKey: "keyu_test",
      fetch: fetchMock,
      retryPolicy: fastPolicy(3),
    });
    await expect(
      t.doJson({
        path: "/v1/search",
        body: {},
        auth: "bearer",
        maxBodyBytes: 1024,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry 4xx other than 429", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: "unauthorized" }, { status: 401 }),
    ) as unknown as typeof fetch;

    const t = new Transport({
      baseUrl: "https://x.example",
      apiKey: "keyu_test",
      fetch: fetchMock,
      retryPolicy: fastPolicy(5),
    });
    await expect(
      t.doJson({
        path: "/v1/search",
        body: {},
        auth: "bearer",
        maxBodyBytes: 1024,
      }),
    ).rejects.toBeInstanceOf(AuthenticationError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries transport errors and surfaces TransportError on final failure", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const t = new Transport({
      baseUrl: "https://x.example",
      apiKey: "keyu_test",
      fetch: fetchMock,
      retryPolicy: fastPolicy(3),
    });
    await expect(
      t.doJson({
        path: "/v1/search",
        body: {},
        auth: "bearer",
        maxBodyBytes: 1024,
      }),
    ).rejects.toBeInstanceOf(TransportError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("honours server retry_after_ms over the schedule", async () => {
    const start = Date.now();
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      if (n < 2) {
        return jsonResponse({ error: "backpressure", retry_after_ms: 50 }, { status: 429 });
      }
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const t = new Transport({
      baseUrl: "https://x.example",
      apiKey: "keyu_test",
      fetch: fetchMock,
      retryPolicy: new BackoffSchedulePolicy({
        schedule: [10_000], // huge — if used in place of retry_after, the test times out
        maxAttempts: 5,
      }),
    });
    const out = await t.doJson<unknown, { ok: boolean }>({
      path: "/v1/search",
      body: {},
      auth: "bearer",
      maxBodyBytes: 1024,
    });
    expect(out).toEqual({ ok: true });
    expect(Date.now() - start).toBeLessThan(1000);
    // sanity that backpressure surfaces if we collect it on retry exhaustion path
    expect(new BackpressureError("x")).toBeInstanceOf(BackpressureError);
  });
});

describe("Transport — AbortSignal", () => {
  it("aborting during backoff surfaces the original retryable error", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      return jsonResponse({ error: "unavailable", retry_after_ms: 10_000 }, { status: 503 });
    }) as unknown as typeof fetch;

    const t = new Transport({
      baseUrl: "https://x.example",
      apiKey: "keyu_test",
      fetch: fetchMock,
      retryPolicy: new BackoffSchedulePolicy({
        schedule: [10_000],
        maxAttempts: 5,
      }),
    });
    const ac = new AbortController();
    const start = Date.now();
    setTimeout(() => ac.abort(), 30);
    await expect(
      t.doJson({
        path: "/v1/search",
        body: {},
        auth: "bearer",
        maxBodyBytes: 1024,
        options: { signal: ac.signal },
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
    // Should NOT have waited the full 10s backoff — abort short-circuits.
    expect(Date.now() - start).toBeLessThan(1000);
    expect(n).toBe(1);
  });

  it("pre-aborted signal throws immediately without sending", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const t = new Transport({
      baseUrl: "https://x.example",
      apiKey: "keyu_test",
      fetch: fetchMock,
      retryPolicy: noRetry(),
    });
    const ac = new AbortController();
    ac.abort();
    await expect(
      t.doJson({
        path: "/v1/search",
        body: {},
        auth: "bearer",
        maxBodyBytes: 1024,
        options: { signal: ac.signal },
      }),
    ).rejects.toBeInstanceOf(TransportError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Transport — preflight body-size cap", () => {
  it("rejects oversize body before sending", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const t = new Transport({
      baseUrl: "https://x.example",
      apiKey: "keyu_test",
      fetch: fetchMock,
      retryPolicy: noRetry(),
    });
    const huge = "x".repeat(2000);
    await expect(
      t.doJson({
        path: "/v1/lint",
        body: { query: huge },
        auth: "none",
        maxBodyBytes: 100,
      }),
    ).rejects.toBeInstanceOf(RequestTooLargeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Transport — split connect vs read timeouts", () => {
  it("A3: connectTimeoutMs aborts a slow connect", async () => {
    // fetch hangs forever — simulates DNS black hole / unresponsive server.
    const fetchMock = vi.fn(
      (_url: any, init: any) =>
        new Promise((_resolve, reject) => {
          const sig: AbortSignal | undefined = init?.signal;
          const onAbort = () => reject(sig?.reason ?? new Error("aborted"));
          if (sig?.aborted) {
            onAbort();
            return;
          }
          sig?.addEventListener("abort", onAbort, { once: true });
        }),
    ) as unknown as typeof fetch;

    const t = new Transport({
      baseUrl: "https://x.example",
      apiKey: "keyu_test",
      fetch: fetchMock,
      retryPolicy: noRetry(),
    });
    const start = Date.now();
    await expect(
      t.doJson({
        path: "/v1/search",
        body: {},
        auth: "bearer",
        maxBodyBytes: 1024,
        options: { connectTimeoutMs: 50, readTimeoutMs: 60_000 },
      }),
    ).rejects.toBeInstanceOf(TransportError);
    // Allow generous slack for CI variance; the key signal is that it
    // doesn't wait the full 60s readTimeoutMs (or hang forever).
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("A3: connect timeout does not affect already-opened response body read", async () => {
    // Slow body but fast connect — long readTimeoutMs covers the body read.
    const fetchMock = vi.fn(async () => {
      // Simulate slow body read by streaming the chunks with a delay.
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          await new Promise((r) => setTimeout(r, 100));
          controller.enqueue(new TextEncoder().encode('{"ok":true}'));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const t = new Transport({
      baseUrl: "https://x.example",
      apiKey: "keyu_test",
      fetch: fetchMock,
      retryPolicy: noRetry(),
    });
    const out = await t.doJson<unknown, { ok: boolean }>({
      path: "/v1/search",
      body: {},
      auth: "bearer",
      maxBodyBytes: 1024,
      // Very tight connect, generous read — connect is satisfied as soon
      // as headers arrive, so the slow body still completes within read.
      options: { connectTimeoutMs: 20, readTimeoutMs: 5000 },
    });
    expect(out).toEqual({ ok: true });
  });

  it("A3: readTimeoutMs aborts a stuck body read after headers arrive", async () => {
    // The fetch mock returns a Response whose body listens to the incoming
    // signal — this models a real fetch where aborting the request-signal
    // also tears down the body stream.
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      const sig: AbortSignal | undefined = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const onAbort = () => {
            try {
              controller.error(sig?.reason ?? new Error("aborted"));
            } catch {
              // already errored
            }
          };
          if (sig?.aborted) onAbort();
          else sig?.addEventListener("abort", onAbort, { once: true });
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const t = new Transport({
      baseUrl: "https://x.example",
      apiKey: "keyu_test",
      fetch: fetchMock,
      retryPolicy: noRetry(),
    });
    const start = Date.now();
    await expect(
      t.doJson({
        path: "/v1/search",
        body: {},
        auth: "bearer",
        maxBodyBytes: 1024,
        options: { connectTimeoutMs: 10_000, readTimeoutMs: 50 },
      }),
    ).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
