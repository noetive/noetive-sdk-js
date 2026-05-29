/**
 * Probe the unauthenticated endpoints: health + lint.
 *
 * Run:
 *   npx tsx examples/health-and-lint.ts
 */

import { Client } from "../src/index.js";

const client = new Client({
  // Health and lint don't need the key — but Client construction does.
  apiKey: process.env.NOETIVE_KEY_SECRET ?? "placeholder-for-unauth-endpoints",
});

await client.semantik.health();
console.log("health: ok");

const result = await client.semantik.lint({
  query: 'MATCH DISTANCE("machine learning") WITHIN 0.4 LIMIT 5',
});
console.log("lint.valid:", result.valid);
console.log("lint.normalized:", result.normalized);
if (result.diagnostics?.length) {
  for (const d of result.diagnostics) {
    console.log(`  ${d.severity}: ${d.message} @${d.line}:${d.col}`);
  }
}
