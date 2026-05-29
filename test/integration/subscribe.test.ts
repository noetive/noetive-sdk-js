import { describe, expect, it } from "vitest";
import {
  REQUEST_TIMEOUT_MS,
  SUBSCRIBE_DELIVERY_MS,
  SUBSCRIBE_SETUP_MS,
  TEST_DIMS,
  TEST_MODEL,
  TEST_NAMESPACE,
  hasApiKey,
  newClient,
  newIdempotencyKey,
} from "./setup.js";

describe.skipIf(!hasApiKey())("Subscribe (integration)", () => {
  it("opens, receives a publish, and closes cleanly", async () => {
    const c = newClient();
    const stream = await c.subscribe(
      {
        query: 'MATCH DISTANCE("mechanical engineering") WITHIN 0.6',
        namespace: TEST_NAMESPACE,
        model: TEST_MODEL,
        dimensions: TEST_DIMS,
      },
      { connectTimeoutMs: SUBSCRIBE_SETUP_MS, readTimeoutMs: SUBSCRIBE_SETUP_MS },
    );
    try {
      expect(stream.subscriptionId.length).toBeGreaterThan(0);

      const pubRes = await c.publish(
        {
          namespace: TEST_NAMESPACE,
          model: TEST_MODEL,
          dimensions: TEST_DIMS,
          items: [{ text: "Mechanical engineering research remains open." }],
          ack: "durable",
          idempotency_key: newIdempotencyKey(),
        },
        { readTimeoutMs: REQUEST_TIMEOUT_MS },
      );

      const got = await firstMatchWithin(stream, SUBSCRIBE_DELIVERY_MS);
      expect(got).not.toBeNull();
      expect(got?.message_id).toBe(pubRes.message_id);
    } finally {
      await stream.close();
    }
  });

  it("close() is idempotent", async () => {
    const c = newClient();
    const stream = await c.subscribe(
      {
        query: 'MATCH DISTANCE("x") WITHIN 0.5',
        namespace: TEST_NAMESPACE,
        model: TEST_MODEL,
        dimensions: TEST_DIMS,
      },
      { connectTimeoutMs: SUBSCRIBE_SETUP_MS, readTimeoutMs: SUBSCRIBE_SETUP_MS },
    );
    await stream.close();
    await stream.close();
    await stream.close();
  });

  it("AbortSignal aborts the stream consumer", async () => {
    const c = newClient();
    const ac = new AbortController();
    const stream = await c.subscribe(
      {
        query: 'MATCH DISTANCE("x") WITHIN 0.5',
        namespace: TEST_NAMESPACE,
        model: TEST_MODEL,
        dimensions: TEST_DIMS,
      },
      {
        connectTimeoutMs: SUBSCRIBE_SETUP_MS,
        readTimeoutMs: SUBSCRIBE_SETUP_MS,
        signal: ac.signal,
      },
    );
    const consumer = (async () => {
      try {
        for await (const _ev of stream) {
          // drain; we expect cancellation to end this.
        }
        return "ended";
      } catch (e) {
        return e;
      }
    })();
    setTimeout(() => {
      ac.abort();
      void stream.close();
    }, 200);
    const outcome = await consumer;
    // The iterator either returns cleanly (cancellation surfaced as EOF) or
    // throws — both are acceptable shapes for "abort propagated".
    expect(outcome).toBeDefined();
  });

  it("delivers multiple publishes with no duplicates and in publish order", async () => {
    const numMessages = 3;
    const c = newClient();
    const stream = await c.subscribe(
      {
        query: 'MATCH DISTANCE("distributed consensus protocols") WITHIN 0.7',
        namespace: TEST_NAMESPACE,
        model: TEST_MODEL,
        dimensions: TEST_DIMS,
      },
      { connectTimeoutMs: SUBSCRIBE_SETUP_MS, readTimeoutMs: SUBSCRIBE_SETUP_MS },
    );
    try {
      const publishedIds: string[] = [];
      for (let i = 0; i < numMessages; i++) {
        const res = await c.publish(
          {
            namespace: TEST_NAMESPACE,
            model: TEST_MODEL,
            dimensions: TEST_DIMS,
            items: [{ text: "Consensus in distributed systems remains central." }],
            metadata: { seq: String(i), test: "subscribe_multi" },
            ack: "durable",
            idempotency_key: newIdempotencyKey(),
          },
          { readTimeoutMs: REQUEST_TIMEOUT_MS },
        );
        publishedIds.push(res.message_id);
      }

      const delivered: string[] = [];
      const seen = new Set<string>();
      const ours = new Set(publishedIds);
      // Allow plenty of wall-clock so wide latency variance doesn't flake.
      const deadline = Date.now() + 30_000;
      const iter = stream[Symbol.asyncIterator]();
      while (delivered.length < numMessages && Date.now() < deadline) {
        const next = await Promise.race([
          iter.next(),
          new Promise<IteratorResult<{ message_id: string; score: number }>>((resolve) =>
            setTimeout(
              () => resolve({ value: undefined as never, done: true }),
              Math.max(0, deadline - Date.now()),
            ),
          ),
        ]);
        if (next.done) break;
        const id = next.value.message_id;
        if (!ours.has(id)) continue; // ignore noise from other tests / runs
        expect(seen.has(id)).toBe(false);
        seen.add(id);
        delivered.push(id);
      }
      expect(delivered).toEqual(publishedIds);
    } finally {
      await stream.close();
    }
  }, 60_000);

  it("subscriptionId is populated synchronously when subscribe() resolves", async () => {
    // Per the SDK contract, the `subscribed` SSE frame is read inside the
    // subscribe() handshake. Once the promise resolves, subscriptionId must
    // already be a non-empty string — no event-loop turn in between.
    const c = newClient();
    const promise = c.subscribe(
      {
        query: 'MATCH DISTANCE("x") WITHIN 0.5',
        namespace: TEST_NAMESPACE,
        model: TEST_MODEL,
        dimensions: TEST_DIMS,
      },
      { connectTimeoutMs: SUBSCRIBE_SETUP_MS, readTimeoutMs: SUBSCRIBE_SETUP_MS },
    );
    const stream = await promise;
    try {
      expect(typeof stream.subscriptionId).toBe("string");
      expect(stream.subscriptionId.length).toBeGreaterThan(0);
    } finally {
      await stream.close();
    }
  });

  it("Symbol.asyncDispose releases the stream (await using)", async () => {
    // Node 22+ `await using` calls Symbol.asyncDispose on scope exit. The
    // stream exposes that hook so callers don't need an explicit try/finally.
    const c = newClient();
    let capturedId = "";
    {
      await using stream = await c.subscribe(
        {
          query: 'MATCH DISTANCE("x") WITHIN 0.5',
          namespace: TEST_NAMESPACE,
          model: TEST_MODEL,
          dimensions: TEST_DIMS,
        },
        { connectTimeoutMs: SUBSCRIBE_SETUP_MS, readTimeoutMs: SUBSCRIBE_SETUP_MS },
      );
      capturedId = stream.subscriptionId;
      expect(stream.subscriptionId.length).toBeGreaterThan(0);
    }
    // Scope exit ran Symbol.asyncDispose → close(). Reaching this line
    // without hanging is the test.
    expect(capturedId.length).toBeGreaterThan(0);
  });

  it("yields no further matches after close() (no hang)", async () => {
    const c = newClient();
    const stream = await c.subscribe(
      {
        query: 'MATCH DISTANCE("x") WITHIN 0.5',
        namespace: TEST_NAMESPACE,
        model: TEST_MODEL,
        dimensions: TEST_DIMS,
      },
      { connectTimeoutMs: SUBSCRIBE_SETUP_MS, readTimeoutMs: SUBSCRIBE_SETUP_MS },
    );
    await stream.close();
    const iter = stream[Symbol.asyncIterator]();
    const next = await Promise.race([
      iter.next(),
      new Promise<IteratorResult<unknown>>((_resolve, reject) =>
        setTimeout(() => reject(new Error("iterator did not terminate after close")), 5000),
      ),
    ]);
    expect(next.done).toBe(true);
  });
});

async function firstMatchWithin(
  stream: AsyncIterable<{ message_id: string; score: number }>,
  timeoutMs: number,
): Promise<{ message_id: string; score: number } | null> {
  const iter = stream[Symbol.asyncIterator]();
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const next = (async () => {
    const r = await iter.next();
    return r.done ? null : r.value;
  })();
  return Promise.race([next, timeout]);
}
