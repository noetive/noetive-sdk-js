/**
 * Wire-format request and response interfaces for the Semantik endpoints.
 * Field names use snake_case to match the JSON envelope exactly — these
 * objects go straight through `JSON.stringify` onto the wire.
 */

/** Acknowledgement durability for publish. */
export type AckMode = "stored" | "durable";

export interface PublishItem {
  /** UTF-8 text to embed server-side. Exactly one of `text` or `vector` must be set. */
  text?: string;
  /** Pre-computed embedding vector. Exactly one of `text` or `vector` must be set. */
  vector?: number[];
}

/**
 * Body of `POST /v1/publish`.
 *
 * `namespace`, `model`, and `dimensions` are REQUIRED — the SDK applies no
 * default. A request that leaves any of them unset/empty/zero is rejected at
 * preflight, never silently routed: defaulting `namespace` to a shared value
 * would let a forgotten field publish sensitive data into a namespace the
 * caller never intended (a data-isolation hazard). They are typed optional only
 * so the validator can produce a clear error instead of a TypeScript-only
 * failure; pass all three explicitly, e.g. `namespace: "global"`,
 * `model: "Qwen3-Embedding-4B"`, `dimensions: 1024`.
 */
export interface PublishRequest {
  items: PublishItem[];
  /** REQUIRED. No SDK default — an empty namespace fails preflight. */
  namespace?: string;
  /** REQUIRED. No SDK default — an empty model fails preflight. */
  model?: string;
  /** REQUIRED. No SDK default — a zero/missing value fails preflight. */
  dimensions?: number;
  metadata?: Record<string, string>;
  /** Body-field deduplication key. Sent on every retry. */
  idempotency_key?: string;
  /** Durability mode; defaults to `"stored"` when omitted. */
  ack?: AckMode;
}

export interface PublishResponse {
  message_id: string;
  /**
   * Epoch component of a message's position; spec type is `uint64`. JS numbers
   * are IEEE-754 doubles and only represent integers exactly up to
   * `Number.MAX_SAFE_INTEGER` (2^53-1), so compare these values rather than
   * doing arithmetic on them, and never compare across namespaces.
   */
  epoch: number;
  /**
   * Ordering component of a message's position; spec type is `uint64`, with the
   * same precision caveat as `epoch`.
   *
   * Position within a namespace is the pair `(epoch, seq)`, compared
   * lexicographically. `seq` orders messages within an epoch and restarts from
   * a low value when the epoch advances, so ordering two messages by `seq`
   * alone reports a routine epoch advance as messages arriving out of order.
   */
  seq: number;
}

/**
 * Body of `POST /v1/search`. `namespace`, `model`, and `dimensions` are
 * REQUIRED with no SDK default — see `PublishRequest` for the data-isolation
 * rationale.
 */
export interface SearchRequest {
  query: string;
  /** REQUIRED. No SDK default — an empty namespace fails preflight. */
  namespace?: string;
  /** REQUIRED. No SDK default — an empty model fails preflight. */
  model?: string;
  /** REQUIRED. No SDK default — a zero/missing value fails preflight. */
  dimensions?: number;
  /** When > 0, overrides the SemQL `LIMIT` clause; 0 means use SemQL / default. */
  limit?: number;
}

export interface ResultItem {
  message_id?: string;
  content?: string;
  metadata?: Record<string, string>;
  score?: number;
  namespace?: string;
}

export interface SearchResponse {
  results?: ResultItem[];
}

export interface LintRequest {
  query: string;
  /** Byte offset into `query`; 0 means end of query. */
  cursor?: number;
}

export interface LintDiagnostic {
  severity?: string;
  message?: string;
  line?: number;
  col?: number;
  end_line?: number;
  end_col?: number;
}

export interface LintCompletion {
  label?: string;
  kind?: string;
  detail?: string;
}

export interface LintResponse {
  normalized?: string;
  diagnostics?: LintDiagnostic[];
  completions?: LintCompletion[];
  valid?: boolean;
}

/**
 * Body of `POST /v1/subscribe`. `namespace`, `model`, and `dimensions` are
 * REQUIRED with no SDK default — see `PublishRequest` for the data-isolation
 * rationale.
 */
export interface SubscribeRequest {
  query: string;
  /** REQUIRED. No SDK default — an empty namespace fails preflight. */
  namespace?: string;
  /** REQUIRED. No SDK default — an empty model fails preflight. */
  model?: string;
  /** REQUIRED. No SDK default — a zero/missing value fails preflight. */
  dimensions?: number;
}

/** Payload of the first SSE frame on a subscribe stream. */
export interface SubscribedEvent {
  subscription_id: string;
}

/** Payload of each `match` frame on a subscribe stream. */
export interface MatchEvent {
  message_id: string;
  score: number;
}
