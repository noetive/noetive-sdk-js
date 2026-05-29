/**
 * Retry policy for transient HTTP failures.
 *
 * Default: 6 attempts (5 retries) on a fixed backoff schedule of
 * `[100ms, 2s, 5s, 10s]`. Attempts beyond the table saturate at the
 * last entry (10s). The schedule is intentionally aggressive on the
 * first retry — most transient blips (connection reset, embedder
 * cold-start) clear within a few hundred milliseconds — and patient
 * thereafter so a degraded server is not flooded.
 *
 * Retried:
 * - `RateLimitError` and its subclasses (`BackpressureError`,
 *   `TooManyRequestsError`).
 * - `ServiceUnavailableError` and its subclasses (`NamespaceUnavailableError`,
 *   `MeteringUnavailableError`).
 * - `TransportError` (DNS, connect, abort-without-response).
 *
 * Not retried:
 * - Other 4xx (client bugs).
 * - `APIError` / `internal_error` (server-side bug; opt callers in via a
 *   custom policy when paired with an idempotency key).
 * - Preflight failures (`httpStatus === 0`).
 *
 * Server-supplied `retryAfterMs` always wins over the schedule — the server
 * knows the real recovery time. The hint is capped at one hour inside
 * `errorFromResponse` to defend against misbehaving intermediaries.
 */

import {
  type NoetiveError,
  RateLimitError,
  ServiceUnavailableError,
  TransportError,
} from "./errors.js";

export interface RetryPolicy {
  /** Total attempts including the first. `6` means five retries. */
  readonly maxAttempts: number;
  /**
   * Return the milliseconds to wait before the next retry, or `null` to stop.
   * `attempt` is 1-based: the *first* retry is `attempt = 1`.
   */
  delayFor(error: NoetiveError, attempt: number): number | null;
}

/**
 * Default backoff schedule shared across all Noetive SDKs. Index `i` is the
 * delay before the `i+1`-th retry. Attempts past the table saturate at the
 * last entry. Picked to match the Rust SDK's `[100ms, 2s, 5s, 10s]`
 * cross-language baseline.
 */
export const DEFAULT_BACKOFF_SCHEDULE_MS: readonly number[] = Object.freeze([
  100, 2000, 5000, 10_000,
]);

/** Cap applied when `attempt > schedule.length`. */
const SATURATION_MS = 10_000;

export interface BackoffScheduleOptions {
  /** Default 6 (5 retries + 1 initial). */
  maxAttempts?: number;
  /**
   * Per-attempt delay table. Index 0 is the delay before the *first* retry.
   * Defaults to `DEFAULT_BACKOFF_SCHEDULE_MS`. Attempts beyond the table
   * saturate at the larger of `schedule[last]` and `SATURATION_MS` (10s).
   */
  schedule?: readonly number[];
}

/**
 * The SDK's default retry policy. Backoff is a fixed table lookup keyed by
 * the 1-based attempt index, saturating at the last entry past the end.
 * Pass to `Client({ retryPolicy: ... })` to tune; or use `noRetry()` to
 * disable retries entirely.
 */
export class BackoffSchedulePolicy implements RetryPolicy {
  readonly maxAttempts: number;
  readonly schedule: readonly number[];

  constructor(opts: BackoffScheduleOptions = {}) {
    this.maxAttempts = opts.maxAttempts ?? 6;
    this.schedule =
      opts.schedule && opts.schedule.length > 0 ? opts.schedule : DEFAULT_BACKOFF_SCHEDULE_MS;
  }

  /**
   * Table lookup with saturation. `attempt = 1` returns `schedule[0]`;
   * attempts past the table return `max(schedule[last], SATURATION_MS)`.
   */
  computeBackoff(attempt: number): number {
    if (attempt < 1) return 0;
    const idx = attempt - 1;
    if (idx < this.schedule.length) {
      return this.schedule[idx] ?? SATURATION_MS;
    }
    const last = this.schedule[this.schedule.length - 1] ?? SATURATION_MS;
    return Math.max(last, SATURATION_MS);
  }

  delayFor(error: NoetiveError, attempt: number): number | null {
    if (attempt >= this.maxAttempts) return null;
    if (!isRetryable(error)) return null;
    // Preflight rejections never go to the wire — never retry them.
    if (error.httpStatus === 0 && !(error instanceof TransportError)) return null;
    if (error.retryAfterMs && error.retryAfterMs > 0) {
      return error.retryAfterMs;
    }
    return this.computeBackoff(attempt);
  }
}

/** A retry policy that never retries. */
export class NoRetryPolicy implements RetryPolicy {
  readonly maxAttempts = 1;
  delayFor(): number | null {
    return null;
  }
}

export function noRetry(): RetryPolicy {
  return new NoRetryPolicy();
}

/** Process-wide default policy. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = new BackoffSchedulePolicy();

function isRetryable(error: NoetiveError): boolean {
  return (
    error instanceof RateLimitError ||
    error instanceof ServiceUnavailableError ||
    error instanceof TransportError
  );
}
