import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  InvalidRequestError,
  ModelNotProvisionedError,
  NoetiveError,
} from "../../src/errors.js";
import { SemantikClient } from "../../src/semantik/index.js";
import {
  PROD_BASE_URL,
  REQUEST_TIMEOUT_MS,
  TEST_DIMS,
  TEST_MODEL,
  TEST_NAMESPACE,
  hasApiKey,
  newClient,
  newIdempotencyKey,
  unitVector,
} from "./setup.js";

describe.skipIf(!hasApiKey())("Publish (integration)", () => {
  it("publishes a text item with stored ack", async () => {
    const c = newClient();
    const t0 = Date.now();
    const res = await c.publish(
      {
        namespace: TEST_NAMESPACE,
        model: TEST_MODEL,
        dimensions: TEST_DIMS,
        items: [{ text: "Stored ack test." }],
        ack: "stored",
        idempotency_key: newIdempotencyKey(),
      },
      { readTimeoutMs: REQUEST_TIMEOUT_MS },
    );
    console.log(`  Publish text stored          ${Date.now() - t0}ms`);
    expect(res.message_id.length).toBeGreaterThan(0);
    expect(res.epoch).toBeGreaterThan(0);
    expect(res.seq).toBeGreaterThan(0);
  });

  it("publishes a text item with durable ack", async () => {
    const c = newClient();
    const t0 = Date.now();
    const res = await c.publish(
      {
        namespace: TEST_NAMESPACE,
        model: TEST_MODEL,
        dimensions: TEST_DIMS,
        items: [{ text: "Durable ack test." }],
        ack: "durable",
        idempotency_key: newIdempotencyKey(),
      },
      { readTimeoutMs: REQUEST_TIMEOUT_MS },
    );
    console.log(`  Publish text durable         ${Date.now() - t0}ms`);
    expect(res.message_id.length).toBeGreaterThan(0);
  });

  it("publishes a pre-computed vector", async () => {
    const c = newClient();
    const t0 = Date.now();
    const res = await c.publish(
      {
        namespace: TEST_NAMESPACE,
        model: TEST_MODEL,
        dimensions: TEST_DIMS,
        items: [{ vector: unitVector(TEST_DIMS) }],
        idempotency_key: newIdempotencyKey(),
      },
      { readTimeoutMs: REQUEST_TIMEOUT_MS },
    );
    console.log(`  Publish vector               ${Date.now() - t0}ms`);
    expect(res.message_id.length).toBeGreaterThan(0);
  });

  it("returns the same message_id when an idempotency key repeats", async () => {
    const c = newClient();
    const key = newIdempotencyKey();
    const body = {
      namespace: TEST_NAMESPACE,
      model: TEST_MODEL,
      dimensions: TEST_DIMS,
      items: [{ text: "dedupe me" }],
      ack: "durable" as const,
      idempotency_key: key,
    };
    const first = await c.publish(body, { readTimeoutMs: REQUEST_TIMEOUT_MS });
    const second = await c.publish(body, { readTimeoutMs: REQUEST_TIMEOUT_MS });
    expect(second.message_id).toBe(first.message_id);
  });

  it("surfaces a server-side invalid_request (dimensions mismatch)", async () => {
    const c = newClient();
    await expect(
      c.publish(
        {
          namespace: TEST_NAMESPACE,
          model: TEST_MODEL,
          dimensions: TEST_DIMS,
          items: [{ vector: [1, 2, 3] }], // wrong length → server rejects
          idempotency_key: newIdempotencyKey(),
        },
        { readTimeoutMs: REQUEST_TIMEOUT_MS },
      ),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("server-side errors carry a non-empty request_id for support pivots", async () => {
    // Spec: every response — success or error — carries X-Request-Id, and the
    // error body repeats it. The SDK exposes it as err.requestId. Quote it
    // when contacting support. Use a (model, dimensions) mismatch with a
    // text-only item so the request passes preflight and the server itself
    // rejects with `model_not_provisioned` (a 400 with body request_id).
    const c = newClient();
    let err: unknown;
    try {
      await c.publish(
        {
          namespace: TEST_NAMESPACE,
          model: TEST_MODEL,
          dimensions: 1023, // 1024 is what `global` provisions
          items: [{ text: "request id pivot check" }],
          idempotency_key: newIdempotencyKey(),
        },
        { readTimeoutMs: REQUEST_TIMEOUT_MS },
      );
    } catch (e) {
      err = e;
    }
    // Server returns 400 with code `model_not_provisioned`; the SDK maps that
    // to ModelNotProvisionedError (a NoetiveError). Either class is fine —
    // the load-bearing assertion is that requestId is populated.
    expect(err).toBeInstanceOf(NoetiveError);
    expect(err).toBeInstanceOf(ModelNotProvisionedError);
    const e = err as NoetiveError;
    expect(e.httpStatus).toBe(400);
    expect(typeof e.requestId).toBe("string");
    expect((e.requestId ?? "").length).toBeGreaterThan(0);
  });

  it("returned epoch and seq fit in Number.MAX_SAFE_INTEGER", async () => {
    // Spec types epoch/seq as uint64; the JS SDK exposes them as `number`.
    // The documented contract is that values fit in IEEE-754 safe integer
    // range. Verify the server agrees today, so a future drift surfaces here.
    const c = newClient();
    const res = await c.publish(
      {
        namespace: TEST_NAMESPACE,
        model: TEST_MODEL,
        dimensions: TEST_DIMS,
        items: [{ text: "precision check" }],
        idempotency_key: newIdempotencyKey(),
      },
      { readTimeoutMs: REQUEST_TIMEOUT_MS },
    );
    expect(Number.isSafeInteger(res.epoch)).toBe(true);
    expect(Number.isSafeInteger(res.seq)).toBe(true);
    expect(res.epoch).toBeGreaterThan(0);
    expect(res.seq).toBeGreaterThan(0);
  });

  it("infers global defaults when namespace/model/dimensions are omitted", async () => {
    // Spec defaults: namespace=global, model=Qwen3-Embedding-4B, dimensions=1024.
    // The SDK fills these in pre-flight. End-to-end check: the publish must
    // succeed without the caller specifying them.
    const c = newClient();
    const res = await c.publish(
      {
        items: [{ text: "defaults inference check" }],
        idempotency_key: newIdempotencyKey(),
      },
      { readTimeoutMs: REQUEST_TIMEOUT_MS },
    );
    expect(res.message_id.length).toBeGreaterThan(0);
  });

  it("surfaces unauthorized for a bad bearer token", async () => {
    const bad = new SemantikClient({
      apiKey: "keyu_00000000000000000000000000000000000000000000",
      baseUrl: PROD_BASE_URL,
    });
    await expect(
      bad.publish(
        {
          namespace: TEST_NAMESPACE,
          model: TEST_MODEL,
          dimensions: TEST_DIMS,
          items: [{ text: "noauth" }],
        },
        { readTimeoutMs: REQUEST_TIMEOUT_MS },
      ),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });
});
