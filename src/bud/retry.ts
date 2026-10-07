/**
 * Retries, and why there are almost none.
 *
 * A write changes the world. `send` is safe to re-issue only with an
 * idempotency key the caller chose; `message.update` is safe to repeat as it
 * was but can overwrite labels another agent wrote in between, so it goes
 * through the same gate. This SDK cannot invent a key: one it generated would
 * differ across a process restart, so a genuine retry would send a second copy
 * while two distinct calls would be collapsed into one.
 *
 * So the rule is narrow and mechanical:
 *
 * - A refusal is never retried. It is an answer, and the envelope says what to do instead.
 * - A wait whose window closed empty is never retried. It is a successful call.
 * - Only a connection that failed before any response arrived reaches a policy at all.
 * - A request that writes is retried only when it carried an idempotency key.
 *
 * The last is enforced by the client around whatever policy is installed, so a
 * custom policy can turn retries off or tune the schedule but cannot make an
 * unkeyed send repeatable.
 */

/** Decides whether to re-issue a request whose connection failed before any response. */
export interface RetryPolicy {
  /**
   * Whether attempt `attempt` (0 for the first try) may be repeated. `op` is
   * the operation (e.g. "send") and `input` the request, so a policy can see
   * whether a write carried a key. Consulted only after the idempotency gate.
   */
  shouldRetry(attempt: number, op: string, input: unknown): boolean;
  /** Resolves when the next attempt may start; rejects when `signal` aborts first. */
  wait(attempt: number, signal?: AbortSignal): Promise<void>;
}

/** Issues every request exactly once. */
export class NoRetry implements RetryPolicy {
  shouldRetry(): boolean {
    return false;
  }
  async wait(): Promise<void> {}
}

/** The pause before each retry when a policy names none: short, because the only thing retried is a connection that did not open. */
export const DEFAULT_BACKOFF_MS: readonly number[] = Object.freeze([100, 1000, 3000]);

export interface TransientRetryOptions {
  /** How many retries, not how many tries. Default 1; 0 behaves as {@link NoRetry}. */
  attempts?: number;
  /** The pause before each retry; past the end the last entry repeats. Default {@link DEFAULT_BACKOFF_MS}. */
  backoffMs?: readonly number[];
}

/** Re-issues a request whose connection failed, at most `attempts` times. The client's default, with one retry. */
export class TransientRetry implements RetryPolicy {
  readonly attempts: number;
  readonly backoffMs: readonly number[];

  constructor(opts: TransientRetryOptions = {}) {
    this.attempts = opts.attempts ?? 1;
    this.backoffMs =
      opts.backoffMs && opts.backoffMs.length > 0 ? opts.backoffMs : DEFAULT_BACKOFF_MS;
  }

  /** Only the count: the client has already refused to repeat an unkeyed write. */
  shouldRetry(attempt: number): boolean {
    return attempt < this.attempts;
  }

  wait(attempt: number, signal?: AbortSignal): Promise<void> {
    const ms = this.backoffMs[Math.min(attempt, this.backoffMs.length - 1)] ?? 0;
    return sleep(ms, signal);
  }
}

/**
 * Whether re-issuing `op` cannot duplicate an effect: it does not write, or it
 * carries a key the caller chose. The client applies this before any policy.
 */
export function mayRepeat(op: string, input: unknown): boolean {
  return !writes(op) || idempotencyKeyOf(input) !== "";
}

/**
 * Whether an operation changes anything. By name, from the closed set this
 * SDK calls; an unclassified operation counts as a write, so adding one cannot
 * quietly make it retryable.
 */
export function writes(op: string): boolean {
  switch (op) {
    case "me.describe":
    case "health":
    case "catalog.describe":
    case "folder.list":
    case "message.describe":
    case "thread.describe":
    case "part.describe":
    case "mailbox.describe":
    case "correspondent.list":
    case "help.describe":
    case "watch":
      return false;
    default:
      return true;
  }
}

/** The idempotency key a write request carries, or "". */
function idempotencyKeyOf(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const key = (input as { idempotency_key?: unknown }).idempotency_key;
  return typeof key === "string" ? key : "";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
