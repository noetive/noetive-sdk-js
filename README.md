# Noetive TypeScript/JavaScript SDK

Official TypeScript/JavaScript client for the [Noetive](https://noetive.io)
platform. Today it exposes **Semantik** — a managed semantic broker where you
publish messages tagged with embedding vectors, query them with SemQL, and
subscribe to live match streams over Server-Sent Events. Additional services
will land on the same root `Client` as the platform grows, reached via service
sub-clients (`client.semantik`, `client.<future>`, …).

- **Universal**: Node 18+, Deno, Bun, and modern browsers via native `fetch`.
- **Dual ESM + CJS**: works with both `import` and `require`.
- **Typed**: hand-authored TypeScript interfaces and a class hierarchy keyed by
  the server's `error` code.
- **Zero runtime dependencies.**
- **Retries built-in**: honours `retry_after_ms` (body) and RFC 9110
  `Retry-After` (header) on 429 and 503.
- **SSE subscriptions**: chunk-safe parser; `AsyncIterable<MatchEvent>` with
  clean `close()` lifecycle, plus `Symbol.asyncDispose` on Node 22+.

## Install

```bash
npm install @noetive/sdk
# or: pnpm add @noetive/sdk / yarn add @noetive/sdk / bun add @noetive/sdk
```

## Authenticate

[Create an API key](https://www.noetive.io/settings/developer-keys) on the
Noetive dashboard. Pass it explicitly or export it as an environment variable:

```bash
export NOETIVE_KEY_SECRET=<your-api-key>
```

`health` and `lint` work without a key; `publish`, `search`, and `subscribe`
require an authenticated account with an active subscription.

Publish, search, and subscribe **require** `namespace`, `model`, and
`dimensions` on every call. The SDK applies no default to these targeting
fields: omitting any of them fails fast at preflight rather than substituting a
value. Defaulting `namespace` to a shared value would let a caller who simply
forgot the field route sensitive data into a namespace they never intended — a
data-isolation hazard the SDK makes impossible. The shared, ready-to-use
namespace is `global`, backed by `Qwen3-Embedding-4B` (1024 dimensions); name it
explicitly when you want it.

## Quickstart

```ts
import { Client } from "@noetive/sdk";

const noetive = new Client(); // reads NOETIVE_KEY_SECRET from env

// namespace, model, and dimensions are required on every call.
await noetive.semantik.publish({
  items: [{ text: "Transformer models reshaped NLP benchmarks." }],
  namespace: "global",
  model: "Qwen3-Embedding-4B",
  dimensions: 1024,
  metadata: { source: "arxiv" },
  ack: "durable",
});

const results = await noetive.semantik.search({
  query: 'MATCH DISTANCE("machine learning") WITHIN 0.4 LIMIT 10',
  namespace: "global",
  model: "Qwen3-Embedding-4B",
  dimensions: 1024,
});
for (const hit of results.results ?? []) {
  console.log(hit.score, hit.content);
}
```

## Subscribe (live matches over SSE)

```ts
import { Client } from "@noetive/sdk";

const noetive = new Client();
const stream = await noetive.semantik.subscribe({
  query: 'MATCH DISTANCE("open-source model releases") WITHIN 0.5',
  namespace: "global",
  model: "Qwen3-Embedding-4B",
  dimensions: 1024,
});

console.log("subscribed:", stream.subscriptionId);
try {
  for await (const match of stream) {
    console.log(match.message_id, match.score);
  }
} finally {
  await stream.close();
}
```

On Node 22+ you can use the `await using` syntax for automatic cleanup:

```ts
await using stream = await noetive.semantik.subscribe({
  query: "…",
  namespace: "global",
  model: "Qwen3-Embedding-4B",
  dimensions: 1024,
});
for await (const match of stream) {
  // …
}
// stream.close() runs at scope exit.
```

### Semantik-only callers

When a process only talks to Semantik, `SemantikClient` can be used directly
without the root client:

```ts
import { SemantikClient } from "@noetive/sdk/semantik";

const semantik = new SemantikClient({ apiKey: process.env.NOETIVE_KEY_SECRET! });
await semantik.publish({
  items: [{ text: "…" }],
  namespace: "global",
  model: "Qwen3-Embedding-4B",
  dimensions: 1024,
});
```

### Targeting a private namespace

The same three required fields target a private namespace you've provisioned on
the dashboard — there is no default, so name the namespace, model, and
dimensions that belong to it:

```ts
await noetive.semantik.publish({
  namespace: "research-papers",
  model: "your-model",
  dimensions: 768,
  items: [{ text: "…" }],
});
```

## Endpoints

All Semantik endpoints are reached through `client.semantik`.

| Method | Purpose | Auth |
|---|---|---|
| `client.semantik.health()` | Liveness probe | No |
| `client.semantik.lint({ query, cursor? })` | Validate a SemQL query; get diagnostics + completions | No |
| `client.semantik.publish({ items, namespace, model, dimensions, metadata?, idempotency_key?, ack? })` | Publish a single message | Yes |
| `client.semantik.search({ query, namespace, model, dimensions, limit? })` | SemQL semantic search | Yes |
| `client.semantik.subscribe({ query, namespace, model, dimensions })` | SSE stream of match events | Yes |

`namespace`, `model`, and `dimensions` are required on `publish`, `search`, and
`subscribe`; the SDK never defaults them (see [Configuration](#configuration)).

Every method accepts an optional second argument `{ signal?: AbortSignal,
connectTimeoutMs?: number, readTimeoutMs?: number }` for per-call
cancellation and timeouts. `connectTimeoutMs` bounds TCP+TLS+headers
(default 10s); `readTimeoutMs` bounds the body read once headers are in
hand (default 30s, does not apply to the long-lived subscribe stream).

### Publish items

A `PublishItem` carries **at least one** of:

- `text` — the server computes the embedding (≤ 32 KB).
- `vector` — a pre-computed embedding (≤ 4096 dimensions).

When both are provided, the server stores the supplied vector as-is and skips
embedding the text. This lets clients that already have an embedding include
the source text in the same request without paying for a server-side embed.

### `ack` durability

| Value | Semantics |
|---|---|
| `"stored"` (default) | Return once the write survives a single server restart. |
| `"durable"` | Return once the write survives power loss. |

### Idempotency

Pass `idempotency_key` to `publish()` so client retries collapse to a single
stored message within the server's retention window. Duplicates return the same
`message_id` and `seq`.

## Error handling

Every error inherits from `NoetiveError`:

```
NoetiveError
├── AuthenticationError        // 401 unauthorized
├── InvalidRequestError        // 400 invalid_request
├── BillingError               // 402 not_billable
├── RequestTooLargeError       // 413 request_too_large
├── UnsupportedMediaTypeError  // 415 unsupported_media_type
├── RateLimitError             // 429 rate_limited
│   ├── TooManyRequestsError   //     too_many_requests
│   └── BackpressureError      //     backpressure (retryAfterMs set)
├── ServiceUnavailableError    // 503 unavailable | namespace_unavailable | metering_unavailable
│   ├── NamespaceUnavailableError
│   └── MeteringUnavailableError
├── NamespaceDisabledError     // namespace administratively disabled
├── ModelNotProvisionedError   // (model, dimensions) tuple not provisioned
├── APIError                   // 500 internal_error
├── MalformedResponseError     // 2xx body the SDK could not parse
├── MalformedSseError          // SSE stream malformed
├── SubscribeSetupError        // subscribe handshake failed (wraps underlying typed error)
├── SubscribeStreamError       // subscribe stream failed after handshake (never retried)
└── TransportError             // network / connect / read failures
```

Every exception carries `code`, `httpStatus`, `requestId`, `retryAfterMs`, and
`responseBody` fields. Compare against `ErrorCodes.*` if you prefer string
matching to `instanceof`.

`httpStatus === 0` signals the SDK's preflight validation rejected the request
before sending it.

## Retries

The default `BackoffSchedulePolicy` makes **five retries** (`maxAttempts: 6`,
six total attempts) on a fixed `100ms, 2s, 5s, 10s` schedule, saturating at
`10s` for attempts past the table. It retries 429, 503, and transport
errors, and honours `retryAfterMs` from the response body and the RFC 9110
`Retry-After` header in preference to the schedule.

Semantik trades a higher transient-error rate for stronger ordering and
survivorship guarantees, so the SDK budgets enough retries to ride through
those windows. Lower `maxAttempts` for latency-sensitive callers; raise it
for batch workloads that can absorb a longer tail.

```ts
import { BackoffSchedulePolicy, Client, noRetry } from "@noetive/sdk";

// Default — recommended:
const client = new Client();

// Latency-sensitive callers:
const tight = new Client({
  retryPolicy: new BackoffSchedulePolicy({ maxAttempts: 2, schedule: [500, 1000] }),
});

// One-shot semantics:
const oneShot = new Client({ retryPolicy: noRetry() });
```

### Retry-safe publishes

The retry loop replays the request as-is, so a `publish()` call without an
`idempotency_key` can produce duplicate stored messages if the first attempt
actually reached the service before surfacing as 429/503/transport error.
**Always pass `idempotency_key` when retries matter** — within the server's
retention window, the same key yields the same `message_id` and `seq`, so
retried writes collapse to one stored message. `search`, `lint`, `health`, and
`subscribe` are side-effect-free and safe to retry unconditionally.

## Configuration

```ts
new Client({
  apiKey,        // or NOETIVE_KEY_SECRET env var
  baseUrl,       // default: https://semantik.noetive.io (or NOETIVE_BASE_URL env var)
  retryPolicy,   // default: BackoffSchedulePolicy()
  connectTimeoutMs, // default: 10000
  readTimeoutMs,    // default: 30000
  fetch,         // default: globalThis.fetch
});
```

## Examples

Runnable scripts under [`examples/`](examples/):

- [`health-and-lint.ts`](examples/health-and-lint.ts) — no-auth endpoints
- [`publish-and-search.ts`](examples/publish-and-search.ts) — publish then search
- [`publish-vector.ts`](examples/publish-vector.ts) — pre-computed embedding vector
- [`subscribe.ts`](examples/subscribe.ts) — SSE subscription
- [`custom-retry.ts`](examples/custom-retry.ts) — custom retry policy
- [`errors.ts`](examples/errors.ts) — error inspection patterns

```bash
NOETIVE_KEY_SECRET=<your-api-key> npx tsx examples/publish-and-search.ts
```

## Debugging — `tools/recorder.ts`

When something looks wrong on the wire, the recorder prints the full HTTP
exchange (request method, URL, headers with the bearer token redacted, request
body, response status, response headers, response body):

```bash
NOETIVE_KEY_SECRET=<your-api-key> npx tsx tools/recorder.ts health
NOETIVE_KEY_SECRET=<your-api-key> npx tsx tools/recorder.ts subscribe 'MATCH DISTANCE("x") WITHIN 0.5' 3
```

Attach the output to bug reports.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run lint
pnpm run test             # unit tests (no network)
pnpm run build            # dual ESM + CJS bundles to dist/

# Integration tests hit the live https://semantik.noetive.io endpoint.
# Skipped when NOETIVE_KEY_SECRET is unset.
NOETIVE_KEY_SECRET=<your-api-key> pnpm run test:integration
```

## Security

To report a vulnerability, see [`SECURITY.md`](SECURITY.md). Do not open a
public GitHub issue for security bugs — email **security@noetive.eu** instead.

## License

See [`LICENSE`](LICENSE).

---

Noetive AB
