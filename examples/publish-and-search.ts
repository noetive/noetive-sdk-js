/**
 * Publish a text message, then run a SemQL search that should find it.
 *
 * Run:
 *   NOETIVE_KEY_SECRET=<your-api-key> npx tsx examples/publish-and-search.ts
 */

import { Client } from "../src/index.js";

const client = new Client();

// namespace, model, and dimensions are REQUIRED on every call — the SDK
// applies no default. Defaulting `namespace` would risk routing data into a
// namespace you never named, so an omitted field fails fast at preflight.
const pub = await client.semantik.publish({
  items: [{ text: "Transformers reshaped NLP benchmarks." }],
  namespace: "global",
  model: "Qwen3-Embedding-4B",
  dimensions: 1024,
  ack: "durable",
  idempotency_key: `example-${Date.now()}-${Math.random().toString(36).slice(2)}`,
});
console.log("publish:", pub);

const found = await client.semantik.search({
  query: 'MATCH DISTANCE("transformer architectures") WITHIN 0.6 LIMIT 5',
  namespace: "global",
  model: "Qwen3-Embedding-4B",
  dimensions: 1024,
});
console.log(`search: ${found.results?.length ?? 0} result(s)`);
for (const r of found.results ?? []) {
  console.log(`  score=${r.score?.toFixed(3)} id=${r.message_id} :: ${r.content}`);
}
