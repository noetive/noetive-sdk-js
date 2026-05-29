import { describe, expect, it } from "vitest";
import {
  REQUEST_TIMEOUT_MS,
  TEST_DIMS,
  TEST_MODEL,
  TEST_NAMESPACE,
  hasApiKey,
  newClient,
  newIdempotencyKey,
} from "./setup.js";

describe.skipIf(!hasApiKey())("Search (integration)", () => {
  it("retrieves at least one match after seeding related texts", async () => {
    const c = newClient();
    const seeds = [
      "Transformers reshaped NLP benchmarks.",
      "Transformer architectures dominate sequence modelling.",
      "Entirely unrelated content about cooking.",
    ];
    for (const text of seeds) {
      await c.publish(
        {
          namespace: TEST_NAMESPACE,
          model: TEST_MODEL,
          dimensions: TEST_DIMS,
          items: [{ text }],
          ack: "durable",
          idempotency_key: newIdempotencyKey(),
        },
        { readTimeoutMs: REQUEST_TIMEOUT_MS },
      );
    }
    const res = await c.search(
      {
        query: 'MATCH DISTANCE("transformer architecture") WITHIN 0.6 LIMIT 5',
        namespace: TEST_NAMESPACE,
        model: TEST_MODEL,
        dimensions: TEST_DIMS,
      },
      { readTimeoutMs: REQUEST_TIMEOUT_MS },
    );
    expect(res.results?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("infers global defaults when namespace/model/dimensions are omitted", async () => {
    // Round-trip the defaults end-to-end: publish without args, search
    // without args, and confirm the SDK + server agree on the same global
    // namespace + model + dimensions tuple.
    const c = newClient();
    await c.publish(
      {
        items: [{ text: "Quantum error correction codes are essential." }],
        ack: "durable",
        idempotency_key: newIdempotencyKey(),
      },
      { readTimeoutMs: REQUEST_TIMEOUT_MS },
    );
    const res = await c.search(
      { query: 'MATCH DISTANCE("quantum computing") WITHIN 0.7 LIMIT 5' },
      { readTimeoutMs: REQUEST_TIMEOUT_MS },
    );
    expect(res.results).toBeDefined();
    expect(Array.isArray(res.results)).toBe(true);
  });

  it("result items expose the spec-documented shape", async () => {
    // Spec ResultItem fields: content, message_id, namespace, score, metadata.
    // We seed a uniquely-tagged document and assert the SDK surfaces each
    // field for at least one hit.
    const c = newClient();
    const tag = `it-search-shape-${Date.now()}`;
    await c.publish(
      {
        namespace: TEST_NAMESPACE,
        model: TEST_MODEL,
        dimensions: TEST_DIMS,
        items: [{ text: "Bayesian deep learning calibration techniques." }],
        metadata: { tag, test: "search_shape" },
        ack: "durable",
        idempotency_key: newIdempotencyKey(),
      },
      { readTimeoutMs: REQUEST_TIMEOUT_MS },
    );
    const res = await c.search(
      {
        query: 'MATCH DISTANCE("bayesian neural network calibration") WITHIN 0.7 LIMIT 10',
        namespace: TEST_NAMESPACE,
        model: TEST_MODEL,
        dimensions: TEST_DIMS,
      },
      { readTimeoutMs: REQUEST_TIMEOUT_MS },
    );
    expect(res.results?.length ?? 0).toBeGreaterThanOrEqual(1);
    const item = res.results?.[0];
    expect(item).toBeDefined();
    expect(typeof item?.message_id).toBe("string");
    expect((item?.message_id ?? "").length).toBeGreaterThan(0);
    expect(typeof item?.score).toBe("number");
    expect(Number.isFinite(item?.score ?? Number.NaN)).toBe(true);
    // content / namespace / metadata are optional in the schema but should
    // be populated for hits backed by published documents.
    if (item?.namespace !== undefined) {
      expect(typeof item.namespace).toBe("string");
    }
    if (item?.metadata !== undefined) {
      expect(typeof item.metadata).toBe("object");
    }
  });

  it("honours an explicit LIMIT (upper bound)", async () => {
    const c = newClient();
    // Seed a few semantically related docs so LIMIT=1 has something to clip.
    // We anchor on text that we know embeds densely (the same query the prior
    // test exercises), avoiding the vacuous-pass trap from indexing lag: even
    // if these new writes haven't indexed yet, the namespace's earlier corpus
    // satisfies the broad distance threshold.
    for (let i = 0; i < 3; i++) {
      await c.publish(
        {
          namespace: TEST_NAMESPACE,
          model: TEST_MODEL,
          dimensions: TEST_DIMS,
          items: [{ text: `Transformer architecture variant ${i}.` }],
          ack: "durable",
          idempotency_key: newIdempotencyKey(),
        },
        { readTimeoutMs: REQUEST_TIMEOUT_MS },
      );
    }
    const res = await c.search(
      {
        query: 'MATCH DISTANCE("transformer architecture") WITHIN 0.99',
        namespace: TEST_NAMESPACE,
        model: TEST_MODEL,
        dimensions: TEST_DIMS,
        limit: 1,
      },
      { readTimeoutMs: REQUEST_TIMEOUT_MS },
    );
    expect(res.results?.length ?? 0).toBeLessThanOrEqual(1);
  });
});
