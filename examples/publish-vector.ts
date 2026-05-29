/**
 * Publish a pre-computed embedding vector with durable ack and a
 * caller-supplied idempotency key. Useful when the client already produced
 * the embedding (e.g. via a local model) and wants to bypass server-side
 * embedding.
 *
 * Run:
 *   NOETIVE_KEY_SECRET=<your-api-key> npx tsx examples/publish-vector.ts
 */

import { Client } from "../src/index.js";
import { DEFAULT_DIMENSIONS } from "../src/semantik/index.js";

const client = new Client();

// Build a deterministic-but-plausible 1024-dimensional vector.
const vector: number[] = [];
for (let i = 0; i < DEFAULT_DIMENSIONS; i++) {
  vector.push((i % 100) / 100);
}

const res = await client.semantik.publish({
  items: [{ vector }],
  ack: "durable",
  idempotency_key: `vector-example-${Date.now()}`,
  metadata: { source: "publish-vector-example" },
});
console.log("publish:", res);
