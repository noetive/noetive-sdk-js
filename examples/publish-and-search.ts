/**
 * Publish a text message, then run a SemQL search that should find it.
 *
 * Run:
 *   NOETIVE_KEY_SECRET=<your-api-key> npx tsx examples/publish-and-search.ts
 */

import { Client } from "../src/index.js";

const client = new Client();

const pub = await client.semantik.publish({
  items: [{ text: "Transformers reshaped NLP benchmarks." }],
  ack: "durable",
  idempotency_key: `example-${Date.now()}-${Math.random().toString(36).slice(2)}`,
});
console.log("publish:", pub);

const found = await client.semantik.search({
  query: 'MATCH DISTANCE("transformer architectures") WITHIN 0.6 LIMIT 5',
});
console.log(`search: ${found.results?.length ?? 0} result(s)`);
for (const r of found.results ?? []) {
  console.log(`  score=${r.score?.toFixed(3)} id=${r.message_id} :: ${r.content}`);
}
