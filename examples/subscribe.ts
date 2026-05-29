/**
 * Open a live match stream and print each delivered match. Press Ctrl-C
 * to exit; the `process.on("SIGINT")` handler closes the stream cleanly.
 *
 * Run:
 *   NOETIVE_KEY_SECRET=<your-api-key> npx tsx examples/subscribe.ts
 */

import { Client } from "../src/index.js";

const client = new Client();
const stream = await client.semantik.subscribe({
  query: 'MATCH DISTANCE("mechanical engineering") WITHIN 0.6',
});

console.log(`subscription_id: ${stream.subscriptionId}`);

let interrupted = false;
process.on("SIGINT", async () => {
  if (interrupted) return;
  interrupted = true;
  console.log("\nclosing stream…");
  await stream.close();
});

try {
  for await (const match of stream) {
    console.log(`match: id=${match.message_id} score=${match.score.toFixed(3)}`);
  }
} finally {
  await stream.close();
}
