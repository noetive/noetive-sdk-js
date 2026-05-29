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

export interface PublishRequest {
  items: PublishItem[];
  namespace?: string;
  model?: string;
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
   * Opaque epoch token; spec type is `uint64`. JS numbers are IEEE-754 doubles
   * and only represent integers exactly up to `Number.MAX_SAFE_INTEGER` (2^53-1).
   * Treat as an opaque token for equality comparison only — never do arithmetic
   * and never compare across namespaces.
   */
  epoch: number;
  /**
   * Opaque per-namespace ordering token; spec type is `uint64`. Same JS number
   * precision caveat as `epoch`: equality only, never arithmetic, never
   * cross-namespace comparison.
   */
  seq: number;
}

export interface SearchRequest {
  query: string;
  namespace?: string;
  model?: string;
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

export interface SubscribeRequest {
  query: string;
  namespace?: string;
  model?: string;
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
