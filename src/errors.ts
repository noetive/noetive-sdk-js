/**
 * Platform-wide exception hierarchy and JSON error-envelope decoder.
 *
 * The Noetive platform returns a stable error envelope on non-2xx responses:
 *
 * ```json
 * { "error": "<code>", "message": "<human>", "request_id": "<id>", "retry_after_ms": <uint>? }
 * ```
 *
 * `fromResponse` maps the envelope (preferred) or the HTTP status (fallback)
 * to one of the typed subclasses below. Service packages may register their
 * own codes via `registerErrorCodes` at module load time — this keeps the
 * code → class mapping in one place without an import cycle into services.
 */

/**
 * Wire-format error codes returned by the Semantik public API.
 *
 * `ErrorCodes` enumerates the codes documented in the published API contract
 * at the time of the SDK release. The server is free to introduce new codes
 * ahead of an SDK update, so `NoetiveError.code` is typed `string | undefined`
 * (not the narrow `ErrorCode` union) and unknown codes flow through verbatim:
 * `errorFromResponse` falls back to `statusMap[status]` and finally `APIError`
 * when the code is not in `codeMap`. Compare against `err.code` to branch on
 * a specific failure mode without having to know which subclass instantiated
 * it.
 */
export const ErrorCodes = Object.freeze({
  InvalidRequest: "invalid_request",
  Unauthorized: "unauthorized",
  NotBillable: "not_billable",
  MethodNotAllowed: "method_not_allowed",
  UnsupportedMediaType: "unsupported_media_type",
  RequestTooLarge: "request_too_large",
  RateLimited: "rate_limited",
  TooManyRequests: "too_many_requests",
  Backpressure: "backpressure",
  Unavailable: "unavailable",
  NamespaceUnavailable: "namespace_unavailable",
  NamespaceDisabled: "namespace_disabled",
  ModelNotProvisioned: "model_not_provisioned",
  MeteringUnavailable: "metering_unavailable",
  InternalError: "internal_error",
  /** Client-side: response was 2xx but body could not be parsed. */
  MalformedResponse: "malformed_response",
  /** Client-side: SSE stream malformed (wrong content-type, frame too large, bad JSON). */
  MalformedSse: "malformed_sse",
} as const);

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Fields shared by every typed error raised by the SDK.
 *
 * - `code`     — machine-readable code from the server envelope, or a client-side code.
 * - `message`  — human-readable description (may be empty).
 * - `httpStatus` — numeric HTTP status; `0` means the SDK's preflight rejected the
 *   request before sending. The adjacent case is a malformed 2xx decode failure,
 *   which surfaces with `code === "malformed_response"` and a non-zero `httpStatus`.
 * - `requestId` — correlation token from `request_id` body field or `X-Request-Id`
 *   header. Quote this when contacting support.
 * - `retryAfterMs` — server's retry hint in milliseconds, when present.
 * - `responseBody` — the decoded JSON envelope, when available; raw bytes otherwise.
 */
export interface NoetiveErrorFields {
  code: string | undefined;
  message: string;
  httpStatus: number;
  requestId: string | undefined;
  retryAfterMs: number | undefined;
  responseBody: unknown;
}

export interface NoetiveErrorInit extends Partial<NoetiveErrorFields> {
  message?: string;
  /** Underlying cause forwarded to `Error.cause` (Node 16+, ES2022). */
  cause?: unknown;
}

export class NoetiveError extends Error {
  /** Default code applied when the constructor does not override it. */
  static defaultCode: string | undefined = undefined;

  /**
   * Whether a server retry hint makes this error worth waiting out.
   *
   * Most errors are either always safe to retry or never are. A few
   * describe a condition the caller cannot fix but the service may
   * resolve shortly; the service signals those by sending
   * `retryAfterMs`. Subclasses that set this to `true` are retried only
   * when that hint is present, and stay terminal without it.
   */
  static retriableWithHint = false;

  readonly code: string | undefined;
  readonly httpStatus: number;
  readonly requestId: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly responseBody: unknown;

  constructor(message: string, init: NoetiveErrorInit = {}) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = new.target.name;
    this.code = init.code ?? (new.target as typeof NoetiveError).defaultCode;
    this.httpStatus = init.httpStatus ?? 0;
    this.requestId = init.requestId;
    this.retryAfterMs = init.retryAfterMs;
    this.responseBody = init.responseBody;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  override toString(): string {
    return this.requestId
      ? `${this.name}: ${this.message} [request_id=${this.requestId}]`
      : `${this.name}: ${this.message}`;
  }
}

/** Network-layer failure: DNS, connect, read, write, TLS, AbortSignal trip. */
export class TransportError extends NoetiveError {}

export class InvalidRequestError extends NoetiveError {
  static override defaultCode: string | undefined = ErrorCodes.InvalidRequest;
}

export class AuthenticationError extends NoetiveError {
  static override defaultCode: string | undefined = ErrorCodes.Unauthorized;
}

export class BillingError extends NoetiveError {
  static override defaultCode: string | undefined = ErrorCodes.NotBillable;
}

export class RequestTooLargeError extends NoetiveError {
  static override defaultCode: string | undefined = ErrorCodes.RequestTooLarge;
}

export class UnsupportedMediaTypeError extends NoetiveError {
  static override defaultCode: string | undefined = ErrorCodes.UnsupportedMediaType;
}

/** HTTP 405 — only POST is accepted on the public endpoints. */
export class MethodNotAllowedError extends NoetiveError {
  static override defaultCode: string | undefined = ErrorCodes.MethodNotAllowed;
}

export class RateLimitError extends NoetiveError {
  static override defaultCode: string | undefined = ErrorCodes.RateLimited;
}

export class TooManyRequestsError extends RateLimitError {
  static override defaultCode: string | undefined = ErrorCodes.TooManyRequests;
}

export class BackpressureError extends RateLimitError {
  static override defaultCode: string | undefined = ErrorCodes.Backpressure;
}

export class ServiceUnavailableError extends NoetiveError {
  static override defaultCode: string | undefined = ErrorCodes.Unavailable;
}

export class NamespaceUnavailableError extends ServiceUnavailableError {
  static override defaultCode: string | undefined = ErrorCodes.NamespaceUnavailable;
}

export class MeteringUnavailableError extends ServiceUnavailableError {
  static override defaultCode: string | undefined = ErrorCodes.MeteringUnavailable;
}

/** Namespace administratively disabled. NOT retryable; user must re-enable. */
export class NamespaceDisabledError extends NoetiveError {
  static override defaultCode: string | undefined = ErrorCodes.NamespaceDisabled;
}

/**
 * Namespace exists but no entry for (model, dimensions).
 *
 * The same code also covers a pairing that is provisioned but not yet
 * ready to serve. The service marks that case by sending a retry hint,
 * and the SDK waits it out; without a hint the pairing is treated as one
 * that will not become available on its own.
 */
export class ModelNotProvisionedError extends NoetiveError {
  static override defaultCode: string | undefined = ErrorCodes.ModelNotProvisioned;
  static override retriableWithHint = true;
}

/** Unexpected server error. Not retried by default. */
export class APIError extends NoetiveError {
  static override defaultCode: string | undefined = ErrorCodes.InternalError;
}

/** Server responded 2xx but body could not be parsed. */
export class MalformedResponseError extends NoetiveError {
  static override defaultCode: string | undefined = ErrorCodes.MalformedResponse;
}

/** SSE stream malformed — wrong Content-Type, oversize frame, bad JSON, missing fields. */
export class MalformedSseError extends NoetiveError {
  static override defaultCode: string | undefined = ErrorCodes.MalformedSse;
}

/**
 * Failure during `/v1/subscribe` setup — before the `subscribed` frame is
 * observed. Wraps the underlying typed error (auth, transport, malformed
 * handshake, etc.). Retryable per the same policy as any other call: the
 * wrapped error's class drives the decision.
 */
export class SubscribeSetupError extends NoetiveError {
  static override defaultCode: string | undefined = undefined;
}

/**
 * Failure during the live subscribe stream — after the `subscribed` frame
 * lands. Never retried automatically: the subscription_id is already
 * committed server-side, and reconnecting would start a fresh subscription
 * (and miss the messages that flowed between the drop and the reconnect).
 */
export class SubscribeStreamError extends NoetiveError {
  static override defaultCode: string | undefined = undefined;
}

/**
 * Wrap an arbitrary failure as a `SubscribeSetupError`, preserving any
 * platform error fields so callers can still branch on `code`,
 * `requestId`, `httpStatus`, etc. The original error is reachable via
 * `Error.cause`.
 */
export function wrapAsSubscribeSetup(err: unknown): SubscribeSetupError {
  if (err instanceof SubscribeSetupError) return err;
  if (err instanceof NoetiveError) {
    return new SubscribeSetupError(err.message, {
      code: err.code,
      httpStatus: err.httpStatus,
      requestId: err.requestId,
      retryAfterMs: err.retryAfterMs,
      responseBody: err.responseBody,
      cause: err,
    });
  }
  const message = err instanceof Error ? err.message : String(err ?? "subscribe setup failed");
  return new SubscribeSetupError(`subscribe setup failed: ${message}`, { cause: err });
}

/**
 * Wrap an arbitrary failure as a `SubscribeStreamError`, preserving any
 * platform error fields. Use after the `subscribed` frame has been read —
 * the surface signals "the stream broke", not "setup failed".
 */
export function wrapAsSubscribeStream(err: unknown): SubscribeStreamError {
  if (err instanceof SubscribeStreamError) return err;
  if (err instanceof NoetiveError) {
    return new SubscribeStreamError(err.message, {
      code: err.code,
      httpStatus: err.httpStatus,
      requestId: err.requestId,
      retryAfterMs: err.retryAfterMs,
      responseBody: err.responseBody,
      cause: err,
    });
  }
  const message = err instanceof Error ? err.message : String(err ?? "subscribe stream failed");
  return new SubscribeStreamError(`subscribe stream failed: ${message}`, { cause: err });
}

const codeMap = new Map<string, typeof NoetiveError>([
  [ErrorCodes.InvalidRequest, InvalidRequestError],
  [ErrorCodes.Unauthorized, AuthenticationError],
  [ErrorCodes.NotBillable, BillingError],
  [ErrorCodes.RequestTooLarge, RequestTooLargeError],
  [ErrorCodes.UnsupportedMediaType, UnsupportedMediaTypeError],
  [ErrorCodes.MethodNotAllowed, MethodNotAllowedError],
  [ErrorCodes.RateLimited, RateLimitError],
  [ErrorCodes.TooManyRequests, TooManyRequestsError],
  [ErrorCodes.Backpressure, BackpressureError],
  [ErrorCodes.Unavailable, ServiceUnavailableError],
  [ErrorCodes.NamespaceUnavailable, NamespaceUnavailableError],
  [ErrorCodes.MeteringUnavailable, MeteringUnavailableError],
  [ErrorCodes.NamespaceDisabled, NamespaceDisabledError],
  [ErrorCodes.ModelNotProvisioned, ModelNotProvisionedError],
  [ErrorCodes.InternalError, APIError],
]);

const statusMap = new Map<number, typeof NoetiveError>([
  [400, InvalidRequestError],
  [401, AuthenticationError],
  [402, BillingError],
  [403, NamespaceDisabledError],
  [405, MethodNotAllowedError],
  [413, RequestTooLargeError],
  [415, UnsupportedMediaTypeError],
  [429, RateLimitError],
  [500, APIError],
  [503, ServiceUnavailableError],
]);

/**
 * Register service-specific code → class mappings. Used by service modules at
 * import time to extend the central decoder; idempotent (later registrations
 * override earlier ones, intentional so hot-reload scenarios stay consistent).
 */
export function registerErrorCodes(codes: Record<string, typeof NoetiveError>): void {
  for (const [code, cls] of Object.entries(codes)) {
    codeMap.set(code, cls);
  }
}

interface ErrorEnvelope {
  error?: string;
  message?: string;
  request_id?: string;
  retry_after_ms?: number;
}

/** Cap a server-supplied retry hint at one hour to defend against misbehaviour. */
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

/**
 * Decode the error envelope from a non-2xx response and instantiate the
 * matching subclass. Tolerant of empty / malformed bodies — the returned
 * error still carries httpStatus and request_id when available.
 *
 * `body` is the decoded JSON (object) when the server returned valid JSON,
 * or the raw text when it did not.
 */
export function errorFromResponse(status: number, headers: Headers, body: unknown): NoetiveError {
  let code: string | undefined;
  let message = "";
  let retryAfterMs: number | undefined;
  let bodyRequestId: string | undefined;

  if (isPlainObject(body)) {
    const env = body as ErrorEnvelope;
    if (typeof env.error === "string" && env.error.length > 0) {
      code = env.error;
    }
    if (typeof env.message === "string") {
      message = env.message;
    }
    if (typeof env.retry_after_ms === "number" && env.retry_after_ms > 0) {
      retryAfterMs = Math.min(env.retry_after_ms, MAX_RETRY_AFTER_MS);
    }
    if (typeof env.request_id === "string" && env.request_id.length > 0) {
      bodyRequestId = env.request_id;
    }
  } else if (typeof body === "string" && body.length > 0) {
    // Preserve a short excerpt of an unparseable body so the caller can
    // debug — but don't let a megabyte of HTML land in error.message.
    const excerpt = body.length <= 256 ? body : `${body.slice(0, 256)}…`;
    message = `malformed body: ${excerpt}`;
  }

  if (retryAfterMs === undefined) {
    retryAfterMs = parseRetryAfterHeader(headers.get("retry-after"));
  }

  if (!message) {
    message = code ? `HTTP ${status} (${code})` : `HTTP ${status}`;
  }

  if (!code) {
    code = statusCodeFallback(status);
  }

  const headerRequestId = headers.get("x-request-id") ?? undefined;
  const requestId = bodyRequestId ?? (headerRequestId || undefined);

  const ErrorClass = (code ? codeMap.get(code) : undefined) ?? statusMap.get(status) ?? APIError;

  return new ErrorClass(message, {
    code,
    httpStatus: status,
    requestId,
    retryAfterMs,
    responseBody: body,
  });
}

/**
 * Parse an RFC 9110 `Retry-After` header. The Semantik service only emits
 * delta-seconds; we accept HTTP-date as a best-effort fallback. Returns
 * milliseconds, capped at one hour. `null` / unparseable values → undefined.
 */
function parseRetryAfterHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const seconds = Number.parseInt(trimmed, 10);
  if (Number.isFinite(seconds) && String(seconds) === trimmed && seconds > 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    if (delta <= 0) return undefined;
    return Math.min(delta, MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

/**
 * Pick a best-guess wire code when the response body was empty or unparseable.
 *
 * Deliberate asymmetry on 429: the protocol has two 429 codes,
 * `backpressure` (retryable with hint) and `rate_limited` (terminal). When the
 * body is absent there's no way to tell which was meant, so the fallback
 * favours `rate_limited` — blind retries of a rate-limit can get the caller
 * blocked harder. A caller that needs backpressure recovery must ensure
 * proxies preserve the JSON body.
 */
function statusCodeFallback(status: number): string {
  switch (status) {
    case 400:
      return ErrorCodes.InvalidRequest;
    case 401:
      return ErrorCodes.Unauthorized;
    case 402:
      return ErrorCodes.NotBillable;
    case 403:
      return ErrorCodes.NamespaceDisabled;
    case 405:
      return ErrorCodes.MethodNotAllowed;
    case 413:
      return ErrorCodes.RequestTooLarge;
    case 415:
      return ErrorCodes.UnsupportedMediaType;
    case 429:
      return ErrorCodes.RateLimited;
    case 503:
      return ErrorCodes.Unavailable;
    default:
      return ErrorCodes.InternalError;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Produce a preflight `InvalidRequestError` — `httpStatus === 0` signals the
 * SDK rejected the request before it reached the wire.
 */
export function preflightError(message: string): InvalidRequestError {
  return new InvalidRequestError(message, {
    code: ErrorCodes.InvalidRequest,
    httpStatus: 0,
  });
}

/** Produce a preflight `RequestTooLargeError` for body-size violations. */
export function preflightTooLarge(message: string): RequestTooLargeError {
  return new RequestTooLargeError(message, {
    code: ErrorCodes.RequestTooLarge,
    httpStatus: 0,
  });
}
