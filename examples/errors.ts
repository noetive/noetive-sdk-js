/**
 * Demonstrate the idiomatic error-handling patterns: instanceof for class
 * matching, the structured fields for diagnostics, and the request_id you
 * pass to support when something goes wrong on the server.
 *
 * Run:
 *   NOETIVE_KEY_SECRET=<your-api-key> npx tsx examples/errors.ts
 */

import {
  AuthenticationError,
  BackpressureError,
  Client,
  InvalidRequestError,
  NoetiveError,
  ServiceUnavailableError,
  TransportError,
} from "../src/index.js";

const client = new Client();

try {
  // Force a server-side invalid_request: vector length ≠ dimensions.
  await client.semantik.publish({
    items: [{ vector: [1, 2, 3] }],
    dimensions: 1024,
  });
} catch (err) {
  if (err instanceof AuthenticationError) {
    console.error("auth failed; rotate the key or check the env var.");
  } else if (err instanceof InvalidRequestError) {
    console.error(`server rejected the request: ${err.message}`);
    console.error(`request_id (for support): ${err.requestId ?? "<none>"}`);
  } else if (err instanceof BackpressureError) {
    console.error(`backpressure; server says retry in ${err.retryAfterMs}ms`);
  } else if (err instanceof ServiceUnavailableError) {
    console.error(`service unavailable: ${err.code}`);
  } else if (err instanceof TransportError) {
    console.error(`network failure: ${err.message}`);
  } else if (err instanceof NoetiveError) {
    console.error(`other Noetive error: ${err.code} (${err.httpStatus})`);
    if (err.httpStatus === 0) console.error("  (preflight — never reached the wire)");
  } else {
    throw err;
  }
}
