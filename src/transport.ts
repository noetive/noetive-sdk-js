/**
 * HTTP transport: wraps `fetch`, adds JSON encoding/decoding, retry, and the
 * shared header set every request must carry.
 *
 * `Transport` is internal. Callers go through `Client` / `SemantikClient`.
 *
 * Timeouts are split into two budgets:
 *
 * - `connectTimeoutMs` bounds how long the SDK waits for the TCP+TLS+HTTP
 *   request to reach response headers. Defaults to 10s. A hung connect
 *   (DNS black hole, server taking too long to write headers) trips this
 *   timer; a successful headers-received clears it before the body is
 *   read.
 * - `readTimeoutMs` bounds how long the SDK waits to finish reading the
 *   response body once headers are in hand. Defaults to 30s. The timer
 *   is NOT armed for the long-lived SSE stream — that path uses the
 *   separate `handshakeTimeoutMs` covering the POST → first frame
 *   round trip, which the streaming layer disarms once the `subscribed`
 *   frame lands.
 */

import {
  MalformedResponseError,
  NoetiveError,
  TransportError,
  errorFromResponse,
  preflightTooLarge,
} from "./errors.js";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "./retry.js";
import { buildUserAgent } from "./userAgent.js";

const HEADER_AUTHORIZATION = "Authorization";
const HEADER_CONTENT_TYPE = "Content-Type";
const HEADER_ACCEPT = "Accept";
const HEADER_USER_AGENT = "User-Agent";

const MIME_JSON = "application/json";
export const MIME_SSE = "text/event-stream";

/** Default connect-budget (TCP+TLS+headers). */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/** Default read-budget (headers-received → body completed). */
export const DEFAULT_READ_TIMEOUT_MS = 30_000;
/**
 * Budget for the `/v1/subscribe` POST → first frame round trip. Bounds the
 * "hung handshake" failure mode. The streaming layer disarms the timer once
 * the `subscribed` frame is observed, so this does NOT constrain the
 * subsequent long-lived match stream.
 */
export const DEFAULT_SUBSCRIBE_HANDSHAKE_TIMEOUT_MS = 15_000;

/**
 * Auth mode for a single request. The `/v1/health` and `/v1/lint` endpoints
 * are unauthenticated (the spec marks them `security: []`); other endpoints
 * require a bearer token.
 */
export type AuthMode = "bearer" | "none";

/**
 * Options shared by every request the transport sends. `signal` is optional;
 * when provided, it composes with the timeout signals so any source can
 * cancel the in-flight request.
 *
 * Per-call timeout overrides take precedence over the client-level defaults
 * configured on `Transport`.
 */
export interface RequestOptions {
  signal?: AbortSignal | undefined;
  /** Per-call connect-timeout override in milliseconds. */
  connectTimeoutMs?: number | undefined;
  /** Per-call read-timeout override in milliseconds. */
  readTimeoutMs?: number | undefined;
}

export interface TransportConfig {
  baseUrl: string;
  apiKey: string;
  retryPolicy?: RetryPolicy | undefined;
  fetch?: typeof fetch | undefined;
  /** Default connect-budget for one-shots and the subscribe handshake. */
  connectTimeoutMs?: number | undefined;
  /** Default read-budget for one-shot JSON responses. */
  readTimeoutMs?: number | undefined;
}

interface JsonRequest<T> {
  path: string;
  body: T;
  auth: AuthMode;
  /** Pre-flight size limit (bytes) for the JSON body. */
  maxBodyBytes: number;
  options?: RequestOptions | undefined;
}

interface SseRequest<T> {
  path: string;
  body: T;
  maxBodyBytes: number;
  options?: RequestOptions | undefined;
  /** Defaults to DEFAULT_SUBSCRIBE_HANDSHAKE_TIMEOUT_MS. */
  handshakeTimeoutMs?: number | undefined;
}

export interface SseResponse {
  response: Response;
  /** Abort the upstream connection. Call from `close()`. Idempotent. */
  abort: () => void;
  /**
   * Clear the handshake-budget timer. Call once the `subscribed` frame is
   * consumed so the timer does not fire during the live stream. Idempotent.
   */
  completeHandshake: () => void;
}

export class Transport {
  readonly baseUrl: string;
  readonly retryPolicy: RetryPolicy;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultConnectMs: number;
  private readonly defaultReadMs: number;

  constructor(cfg: TransportConfig) {
    this.baseUrl = stripTrailingSlash(cfg.baseUrl);
    this.authHeader = `Bearer ${cfg.apiKey}`;
    this.retryPolicy = cfg.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.fetchImpl = cfg.fetch ?? defaultFetch();
    this.defaultConnectMs = cfg.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.defaultReadMs = cfg.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  }

  /** Send a JSON request and decode a JSON response with retry. */
  async doJson<TReq, TRes>(req: JsonRequest<TReq>): Promise<TRes> {
    const encoded = encodeJson(req.body, req.path, req.maxBodyBytes);
    return this.runWithRetry(
      (attempt) => this.sendJsonOnce<TRes>(encoded, req, attempt),
      req.options?.signal,
    );
  }

  /** Send a JSON request with no response body (used by `/v1/health`). */
  async doJsonNoResponse<TReq>(req: JsonRequest<TReq>): Promise<void> {
    const encoded = encodeJson(req.body, req.path, req.maxBodyBytes);
    await this.runWithRetry(async (attempt) => {
      await this.sendJsonOnce<unknown>(encoded, req, attempt, true);
    }, req.options?.signal);
  }

  /**
   * Send the subscribe POST and return the open Response (caller reads the
   * SSE body). Single-attempt: the caller (`openSubscribeStream`) wraps this
   * in the retry loop so each attempt yields a fresh handshake. Once the
   * `subscribed` frame is consumed, errors are stream-side and the
   * subscription_id is committed server-side — retrying then would silently
   * lose matches.
   */
  async openSse<TReq>(req: SseRequest<TReq>): Promise<SseResponse> {
    const encoded = encodeJson(req.body, req.path, req.maxBodyBytes);
    const handshakeMs = req.handshakeTimeoutMs ?? DEFAULT_SUBSCRIBE_HANDSHAKE_TIMEOUT_MS;
    const connectMs = req.options?.connectTimeoutMs ?? this.defaultConnectMs;
    // The handshake budget is the upper bound; the connect timer is the
    // inner bound (fires earlier on a hung TCP). Both share one controller.
    const { signal, controller, clearAll, clearConnect } = composeSignal(req.options?.signal, {
      connectMs,
      // The handshake budget plays the role of the "outer read" for SSE: it
      // covers the gap between headers-received and the first SSE frame.
      // `completeHandshake` disarms it once `subscribed` lands.
      readMs: handshakeMs,
    });

    const headers = new Headers({
      [HEADER_CONTENT_TYPE]: MIME_JSON,
      [HEADER_ACCEPT]: MIME_SSE,
      [HEADER_USER_AGENT]: buildUserAgent(),
      [HEADER_AUTHORIZATION]: this.authHeader,
      // Refuse gzip on SSE: compression on a line-delimited real-time
      // protocol buys nothing and can delay frame delivery.
      "Accept-Encoding": "identity",
    });

    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + req.path, {
        method: "POST",
        headers,
        body: encoded as BodyInit,
        signal,
      });
    } catch (cause) {
      clearAll();
      throw transportErrorFrom(cause);
    }
    // Headers received — disarm the connect timer; the handshake timer
    // stays armed until `completeHandshake` is called.
    clearConnect();

    if (!response.ok) {
      const body = await readBodyAsJsonOrText(response);
      clearAll();
      throw errorFromResponse(response.status, response.headers, body);
    }

    // `abort` is wired to the inner controller so `close()` can tear the
    // upstream connection down. `completeHandshake` clears the handshake
    // budget timer (also clears any leftover connect timer as a safety net).
    return {
      response,
      abort: () => controller.abort(),
      completeHandshake: clearAll,
    };
  }

  private async sendJsonOnce<TRes>(
    encoded: Uint8Array,
    req: JsonRequest<unknown>,
    _attempt: number,
    discardBody = false,
  ): Promise<TRes> {
    const connectMs = req.options?.connectTimeoutMs ?? this.defaultConnectMs;
    const readMs = req.options?.readTimeoutMs ?? this.defaultReadMs;
    const { signal, clearAll, clearConnect, armRead } = composeSignal(req.options?.signal, {
      connectMs,
      // Read timer is armed lazily after headers — pass the value so the
      // helper can re-arm it, but do not start it yet.
      readMs: 0,
    });

    const headers = new Headers({
      [HEADER_CONTENT_TYPE]: MIME_JSON,
      [HEADER_ACCEPT]: MIME_JSON,
      [HEADER_USER_AGENT]: buildUserAgent(),
    });
    if (req.auth === "bearer") {
      headers.set(HEADER_AUTHORIZATION, this.authHeader);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + req.path, {
        method: "POST",
        headers,
        body: encoded as BodyInit,
        signal,
      });
    } catch (cause) {
      clearAll();
      throw transportErrorFrom(cause);
    }
    // Headers received: disarm connect, arm read.
    clearConnect();
    const clearRead = armRead(readMs);

    try {
      if (!response.ok) {
        const body = await readBodyAsJsonOrText(response);
        throw errorFromResponse(response.status, response.headers, body);
      }
      if (discardBody) {
        // Drain to release the connection back to the pool.
        await response.body?.cancel();
        return undefined as TRes;
      }
      const text = await response.text();
      if (!text) {
        return {} as TRes;
      }
      try {
        return JSON.parse(text) as TRes;
      } catch (cause) {
        throw new MalformedResponseError(
          `failed to parse JSON response: ${stringifyCause(cause)}`,
          {
            cause,
            httpStatus: response.status,
            requestId: response.headers.get("x-request-id") ?? undefined,
            responseBody: text,
          },
        );
      }
    } finally {
      clearRead();
      clearAll();
    }
  }

  /**
   * Run `fn` with retry. Retried errors are NoetiveError subclasses; transport
   * errors are wrapped in TransportError before reaching the policy.
   *
   * Attempts are 0-indexed for the initial call; retries pass 1, 2, … to the
   * policy so its arithmetic matches the natural "first retry, second retry"
   * count. The total number of calls is bounded by `policy.maxAttempts`.
   *
   * `signal` is the caller's AbortSignal: if it fires (either before the
   * first attempt or during a backoff sleep), the loop short-circuits and
   * surfaces the abort to the caller instead of running the retry budget
   * down. Without this short-circuit, an aborted request whose underlying
   * `fetch` error came back as a generic transport error would be retried
   * by the default policy — delaying the abort by up to the sum of the
   * backoff schedule.
   *
   * Package-private: consumed by `openSubscribeStream` to retry the WHOLE
   * handshake (POST + content-type check + `subscribed` frame read) on
   * transient failures.
   */
  async runWithRetry<T>(fn: (attempt: number) => Promise<T>, signal?: AbortSignal): Promise<T> {
    let attempt = 0;
    while (true) {
      if (signal?.aborted) {
        throw transportErrorFrom(signal.reason ?? new Error("aborted"));
      }
      try {
        return await fn(attempt);
      } catch (err) {
        if (!(err instanceof NoetiveError)) {
          throw err;
        }
        if (signal?.aborted) throw err;
        const nextAttempt = attempt + 1;
        const delayMs = this.retryPolicy.delayFor(err, nextAttempt);
        if (delayMs === null) {
          throw err;
        }
        try {
          await abortableSleep(delayMs, signal);
        } catch {
          // Abort during backoff — surface the original error so the caller
          // sees what triggered the retry attempt, not a synthetic abort.
          throw err;
        }
        attempt = nextAttempt;
      }
    }
  }
}

/**
 * Encode a JSON body and enforce the per-endpoint body-size cap.
 * Returns a `Uint8Array` so `fetch` can set Content-Length accurately on
 * runtimes that respect it.
 */
function encodeJson(body: unknown, path: string, maxBytes: number): Uint8Array {
  const encoder = new TextEncoder();
  const buf = encoder.encode(JSON.stringify(body));
  if (buf.byteLength > maxBytes) {
    throw preflightTooLarge(
      `request body for ${path} is ${buf.byteLength} bytes, exceeds limit ${maxBytes}`,
    );
  }
  return buf;
}

/** Pick the runtime `fetch`. Throws if no global fetch is available. */
function defaultFetch(): typeof fetch {
  const f = (globalThis as { fetch?: typeof fetch }).fetch;
  if (!f) {
    throw new Error(
      "noetive-sdk: no global fetch found. Node 18+ provides one natively; for older runtimes pass `fetch` via the Client options.",
    );
  }
  return f.bind(globalThis);
}

/**
 * Read a response body as JSON, falling back to text on parse failure.
 * Bounded to 64 KiB so an HTML error page from a misconfigured proxy can't
 * blow up the SDK's memory.
 */
async function readBodyAsJsonOrText(response: Response): Promise<unknown> {
  const cap = 64 * 1024;
  let text: string;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  const trimmed = text.length > cap ? text.slice(0, cap) : text;
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

interface ComposeOptions {
  /** Connect-budget. `0` or negative leaves the timer disarmed. */
  connectMs: number;
  /**
   * Read-budget to arm immediately. `0` or negative leaves the timer
   * disarmed; callers can use `armRead(ms)` later to arm it after headers.
   */
  readMs: number;
}

interface ComposedSignal {
  signal: AbortSignal;
  controller: AbortController;
  /** Disarm the connect timer (idempotent). Read timer untouched. */
  clearConnect: () => void;
  /** Arm (or re-arm) the read timer; returns the disarm fn. */
  armRead: (ms: number) => () => void;
  /** Disarm both timers and detach the outer-signal listener. */
  clearAll: () => void;
}

/**
 * Combine a caller-supplied signal with connect and read timeouts onto a
 * single `AbortController`. Returns the merged signal plus per-timer
 * controls so the caller can disarm connect once headers arrive and arm
 * read once the body read starts.
 */
function composeSignal(outer: AbortSignal | undefined, opts: ComposeOptions): ComposedSignal {
  const controller = new AbortController();
  let connectCleared = false;
  let readTimer: ReturnType<typeof setTimeout> | null = null;
  let allCleared = false;

  const onAbort = () => controller.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) {
      controller.abort(outer.reason);
    } else {
      outer.addEventListener("abort", onAbort, { once: true });
    }
  }

  const connectTimer =
    opts.connectMs > 0
      ? setTimeout(() => {
          controller.abort(new Error(`noetive-sdk: connect timed out after ${opts.connectMs}ms`));
        }, opts.connectMs)
      : null;

  const clearConnect = () => {
    if (connectCleared) return;
    connectCleared = true;
    if (connectTimer) clearTimeout(connectTimer);
  };

  const armRead = (ms: number): (() => void) => {
    if (readTimer) {
      clearTimeout(readTimer);
      readTimer = null;
    }
    if (ms <= 0) return () => {};
    readTimer = setTimeout(() => {
      controller.abort(new Error(`noetive-sdk: read timed out after ${ms}ms`));
    }, ms);
    return () => {
      if (readTimer) {
        clearTimeout(readTimer);
        readTimer = null;
      }
    };
  };

  // Caller may pre-arm a read timer at compose time (used by openSse to
  // arm the handshake budget alongside the connect timer).
  if (opts.readMs > 0) {
    armRead(opts.readMs);
  }

  const clearAll = () => {
    if (allCleared) return;
    allCleared = true;
    clearConnect();
    if (readTimer) {
      clearTimeout(readTimer);
      readTimer = null;
    }
    if (outer) outer.removeEventListener("abort", onAbort);
  };

  return { signal: controller.signal, controller, clearConnect, armRead, clearAll };
}

function transportErrorFrom(cause: unknown): NoetiveError {
  if (cause instanceof NoetiveError) return cause;
  const message =
    cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "transport error";
  return new TransportError(message, { cause, responseBody: cause });
}

function stringifyCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return String(cause);
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Sleep for `ms`, rejecting promptly if `signal` aborts. Cancels the timer on
 * abort so the event loop is not held open by a long backoff after the
 * caller has already given up.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
