/**
 * The live suite's one retry: a request refused as rate_limited is sent once
 * more, after the wait the server named.
 *
 * The suite runs faster than Bud's per-second request limit, so that refusal
 * is a property of the suite's pace, not of the client. The client itself
 * never retries a refusal and must not start; this lives in the harness only.
 * A refused request did nothing, so sending it again is safe for any
 * operation. Only short waits are taken; a longer one fails the test as before.
 */

/** The longest wait the harness takes for the server. */
export const MAX_PACE_MS = 3_000;

export function pacedFetch(next: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const res = await next(input, init);
    if ((res.headers.get("content-type") ?? "").startsWith("text/event-stream")) return res;
    let wait: number | undefined;
    try {
      const body = (await res.clone().json()) as {
        error?: { code?: string; retry_after_ms?: number };
      };
      if (body?.error?.code === "rate_limited") wait = Math.max(body.error.retry_after_ms ?? 1, 1);
    } catch {
      return res;
    }
    if (wait === undefined || wait > MAX_PACE_MS || init?.signal?.aborted) return res;
    await new Promise((resolve) => setTimeout(resolve, wait));
    return next(input, init);
  };
}
