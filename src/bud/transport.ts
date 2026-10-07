/**
 * One HTTP exchange with Bud: headers, the response budget, the redirect
 * refusal, and the retry loop around a connection that failed.
 *
 * There is deliberately no whole-exchange timeout. `wait` holds a response open
 * for up to twenty-five seconds and `watch` for as long as the caller stays
 * attached, so a bound covering the body would sever exactly the calls this
 * client exists to make, in a way that looks like the server going quiet. The
 * one budget here bounds waiting for the response to begin; the caller's
 * AbortSignal bounds everything else.
 */

import { buildUserAgent } from "../userAgent.js";
import { type RetryPolicy, mayRepeat } from "./retry.js";

/**
 * How long to wait for a response to begin. Generous, because it also bounds a
 * wait's handshake, which starts its window only once the stream is open. It
 * never cuts a stream: it is disarmed once the response (for a stream, its
 * opening frame) arrives.
 */
export const DEFAULT_RESPONSE_TIMEOUT_MS = 45_000;

const MIME_JSON = "application/json";
export const MIME_EVENT_STREAM = "text/event-stream";

/** The statuses `fetch` would follow. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface TransportConfig {
  baseUrl: string;
  fetch: typeof fetch;
  retry: RetryPolicy;
  responseTimeoutMs: number;
}

export interface ExchangeOptions {
  signal?: AbortSignal | undefined;
  /** The Authorization header value, or undefined to send none. */
  authorization?: string | undefined;
  /** Ask for an event stream, and keep the response budget armed until {@link Exchange.settle}. */
  stream?: boolean;
}

/** A response in hand, and the means to let it go. */
export interface Exchange {
  readonly response: Response;
  /** The X-Request-Id the response carried, or "". */
  readonly requestId: string;
  /** Disarm the response budget. Idempotent. */
  settle(): void;
  /** Abort the request, releasing the connection, and stop following the caller's signal. Idempotent. */
  end(): void;
}

type Attempt = { exchange: Exchange } | { failed: unknown };

export class BudTransport {
  readonly #cfg: TransportConfig;

  constructor(cfg: TransportConfig) {
    this.#cfg = cfg;
  }

  /**
   * POST `body` to `/v1/{op}` and return the response once its headers arrive.
   *
   * Retried only when the connection failed before any response, and only
   * where repeating cannot duplicate an effect; that gate is applied here,
   * around whatever policy is installed, so no policy can widen it. A caller
   * abort is thrown as the signal's reason and never retried.
   */
  async exchange(
    op: string,
    input: unknown,
    body: string,
    opts: ExchangeOptions,
  ): Promise<Exchange> {
    const signal = opts.signal;
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw signal.reason;
      const result = await this.attempt(op, body, opts);
      if ("exchange" in result) return result.exchange;

      if (signal?.aborted) throw signal.reason;
      if (!mayRepeat(op, input) || !this.#cfg.retry.shouldRetry(attempt, op, input)) {
        throw result.failed;
      }
      try {
        await this.#cfg.retry.wait(attempt, signal);
      } catch {
        if (signal?.aborted) throw signal.reason;
        throw result.failed;
      }
    }
  }

  private async attempt(op: string, body: string, opts: ExchangeOptions): Promise<Attempt> {
    const caller = opts.signal;
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(caller?.reason);
    caller?.addEventListener("abort", onCallerAbort, { once: true });

    const budget = this.#cfg.responseTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined =
      budget > 0
        ? setTimeout(
            () => controller.abort(new Error(`bud: no response within ${budget}ms`)),
            budget,
          )
        : undefined;
    const settle = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      settle();
      caller?.removeEventListener("abort", onCallerAbort);
      controller.abort();
    };

    const headers = new Headers({
      "Content-Type": MIME_JSON,
      "User-Agent": buildUserAgent(),
    });
    if (opts.stream) headers.set("Accept", MIME_EVENT_STREAM);
    if (opts.authorization) headers.set("Authorization", opts.authorization);

    const url = `${this.#cfg.baseUrl}/v1/${op}`;
    let response: Response;
    try {
      response = await this.#cfg.fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
        // Following a redirect would re-attach the Authorization header to
        // whatever Location names, a host the caller never chose.
        redirect: "manual",
      });
    } catch (failed) {
      end();
      return { failed };
    }
    if (!opts.stream) settle();

    if (response.type === "opaqueredirect" || REDIRECTS.has(response.status)) {
      await response.body?.cancel().catch(() => {});
      end();
      throw new Error(
        `bud: refusing to follow a redirect to ${redirectHost(response, url)}; a redirect would send the credential somewhere the caller did not name`,
      );
    }

    const requestId = response.headers.get("X-Request-Id") ?? "";
    return { exchange: { response, requestId, settle, end } };
  }
}

function redirectHost(response: Response, url: string): string {
  const location = response.headers.get("Location");
  if (!location) return "(an unnamed host)";
  try {
    return new URL(location, url).host;
  } catch {
    return "(an unreadable location)";
  }
}

/**
 * Read a body as text, at most `cap` bytes. Bounded because the alternative is
 * letting a misbehaving proxy decide how much this process allocates; a body
 * cut at the cap no longer decodes and is reported as malformed. The caller's
 * signal ends the read with its reason, whether or not the runtime's fetch
 * would have torn the body down on its own.
 */
export async function readText(
  response: Response,
  cap: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const onAbort = () => {
    reader.cancel(signal?.reason).catch(() => {});
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const { value, done } = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (done) break;
      const room = cap - total;
      const chunk = value.byteLength > room ? value.subarray(0, room) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (total >= cap) await reader.cancel().catch(() => {});
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}
