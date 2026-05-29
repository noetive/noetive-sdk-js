/**
 * Tighter retry policy: cut max attempts to 3 and use a custom backoff
 * schedule for latency-sensitive callers. A custom policy can also opt out
 * of retries entirely (see `noRetry()` below).
 *
 * Run:
 *   NOETIVE_KEY_SECRET=<your-api-key> npx tsx examples/custom-retry.ts
 */

import { BackoffSchedulePolicy, Client, noRetry } from "../src/index.js";

// Pick a strategy based on the caller's tolerance for tail latency vs.
// transient failures.
const mode = process.env.RETRY_MODE ?? "tight";

const policy =
  mode === "off"
    ? noRetry()
    : new BackoffSchedulePolicy({
        maxAttempts: 3,
        schedule: [500, 1000, 1500],
      });

const client = new Client({ retryPolicy: policy });

const res = await client.semantik.search({
  query: 'MATCH DISTANCE("retry policy") WITHIN 0.5 LIMIT 1',
});
console.log("results:", res.results?.length ?? 0);
