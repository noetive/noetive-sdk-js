/**
 * Bud refusals, and why this module spends so much on them.
 *
 * A refusal is read once, by whoever is about to decide what to do next. It is
 * not re-sent on every turn the way a tool manifest is, so carrying the limit
 * that fired, when it clears, the guard that refused and the field that was
 * wrong is nearly free — and it is the difference between a plan and a retry
 * loop. "rate_limited" alone leaves a caller to guess; "rate_limited, per_hour,
 * retry in 41m0s" is an instruction. So every field the server sends is kept,
 * and the rendering (`message`) carries the ones that change what happens next.
 *
 * Deliberately separate from the platform error hierarchy in `../errors.ts`:
 * Bud's codes mean different things (`unavailable` here is "this deployment
 * does not serve that option", not a transient outage), so they live in their
 * own class and are never registered with the shared code map.
 */

/** The refusal codes. A closed set, because branching on it is the point. */
export const BudErrorCodes = Object.freeze({
  /** The credential is missing, unknown, revoked or expired. The only refusal that means the key itself does not work. */
  Unauthorized: "unauthorized",
  /** The key is good and the account behind it cannot be charged. Retrying will not help until billing is set up. */
  NotBillable: "not_billable",
  /**
   * The key is good and does not reach what was asked. Never returned for an
   * object the caller cannot read — that is `not_found`, because "forbidden"
   * about an identifier confirms it exists.
   */
  ForbiddenScope: "forbidden_scope",
  /** The object does not exist, exists outside every grant the caller holds, or the operation does not exist. */
  NotFound: "not_found",
  /** Other writes to the same object kept landing first. Read it again and retry; an update is safe to repeat as it was. */
  PreconditionFailed: "precondition_failed",
  /** A guard fired; `guard` names which. Not worth retrying unchanged. */
  PolicyRefused: "policy_refused",
  /**
   * A limit is spent; `counter` names which and `retryAfterMs` when it clears.
   * With no `retryAfterMs`, waiting will not help and the request has to change.
   */
  RateLimited: "rate_limited",
  /** The mailbox is paused. Unlike a rate limit it does not clear on its own. */
  Paused: "paused",
  /** The request was malformed; `field` is a JSON pointer to where, when one field is to blame. */
  Invalid: "invalid",
  /** This deployment does not serve this option of the operation. Retrying will not help. */
  Unavailable: "unavailable",
  /** Something on the server broke. The key is fine; retrying later may succeed. */
  Internal: "internal",
  /** Something Bud depends on could not be reached, and the request had no effect. Retry with backoff. */
  UpstreamUnavailable: "upstream_unavailable",
  /**
   * This SDK's own: the server answered with something that is not the
   * envelope. Distinct from `internal` so a caller can tell "the server failed"
   * from "we could not read what it said".
   */
  MalformedResponse: "malformed_response",
} as const);

export type BudErrorCode = (typeof BudErrorCodes)[keyof typeof BudErrorCodes];

/**
 * A refusal as it travels on the wire, field for field with the server's
 * contract. `JSON.stringify` of a {@link BudError} produces exactly this.
 */
export interface BudErrorBody {
  code: string;
  /** The server's own sentence. Never quotes anything a sender wrote. */
  message: string;
  hint?: string;
  request_id?: string;
  retry_after_ms?: number;
  /** Declared by the wire for a conflict that carries the object as stored; nothing served sets it; a conflict says only to read again. */
  current?: unknown;
  version?: string;
  field?: string;
  guard?: string;
  counter?: string;
}

/**
 * A refusal, with everything the server said about what to do next.
 *
 * Returned as a value on an operation's output (`out.error`), thrown only by
 * `watch`, by a preflight check (`httpStatus` 0), or for a response this SDK
 * could not read (`malformed_response`).
 */
export class BudError extends Error {
  /** What to branch on; one of {@link BudErrorCodes}. */
  readonly code: string;
  /** The server's own sentence, unrendered. `message` is the full rendering. */
  readonly serverMessage: string;
  /** What would unblock this, in the server's words. */
  readonly hint: string;
  /** Correlates this refusal with everything the request caused. Quote it when asking for help. */
  readonly requestId: string;
  /** When the limit clears, on `rate_limited`; 0 when waiting will not help. */
  readonly retryAfterMs: number;
  readonly current: unknown;
  readonly version: string;
  /** A JSON pointer into the request, on `invalid`. */
  readonly field: string;
  /** The policy that fired, on `policy_refused`. */
  readonly guard: string;
  /** The limit that refused, on `rate_limited`. */
  readonly counter: string;
  /**
   * The status the refusal arrived with. 0 means this SDK produced the refusal
   * before anything was sent.
   */
  readonly httpStatus: number;

  constructor(body: BudErrorBody, httpStatus = 0) {
    const fields = {
      code: body.code,
      serverMessage: body.message ?? "",
      hint: body.hint ?? "",
      requestId: body.request_id ?? "",
      retryAfterMs: body.retry_after_ms ?? 0,
      version: body.version ?? "",
      field: body.field ?? "",
      guard: body.guard ?? "",
      counter: body.counter ?? "",
      httpStatus,
    };
    super(render(fields));
    this.name = "BudError";
    this.code = fields.code;
    this.serverMessage = fields.serverMessage;
    this.hint = fields.hint;
    this.requestId = fields.requestId;
    this.retryAfterMs = fields.retryAfterMs;
    this.current = body.current;
    this.version = fields.version;
    this.field = fields.field;
    this.guard = fields.guard;
    this.counter = fields.counter;
    this.httpStatus = httpStatus;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Whether waiting and trying again could succeed.
   *
   * True for `upstream_unavailable` (the server promises no effect),
   * `precondition_failed` (after reading the object again), `internal` (retry a
   * send after it only with the same idempotency key), and `rate_limited` only
   * when it says how long to wait. Everything else is false — notably
   * `unavailable` (this deployment does not serve it), `paused` (clears only
   * when an operator releases it) and `not_billable` (waits on a person).
   */
  retryable(): boolean {
    switch (this.code) {
      case BudErrorCodes.UpstreamUnavailable:
      case BudErrorCodes.PreconditionFailed:
      case BudErrorCodes.Internal:
        return true;
      case BudErrorCodes.RateLimited:
        return this.retryAfterMs > 0;
      default:
        return false;
    }
  }

  /** The wire shape, so a relay can forward an output as the server sent it. */
  toJSON(): BudErrorBody {
    const out: BudErrorBody = { code: this.code, message: this.serverMessage };
    if (this.hint) out.hint = this.hint;
    if (this.requestId) out.request_id = this.requestId;
    if (this.retryAfterMs > 0) out.retry_after_ms = this.retryAfterMs;
    if (this.current !== undefined) out.current = this.current;
    if (this.version) out.version = this.version;
    if (this.field) out.field = this.field;
    if (this.guard) out.guard = this.guard;
    if (this.counter) out.counter = this.counter;
    return out;
  }

  /** True when `value` is a BudError, and carries `code` when one is given. */
  static is(value: unknown, code?: string): value is BudError {
    return value instanceof BudError && (code === undefined || value.code === code);
  }
}

interface Rendered {
  code: string;
  serverMessage: string;
  hint: string;
  requestId: string;
  retryAfterMs: number;
  field: string;
  guard: string;
  counter: string;
  httpStatus: number;
}

/**
 * The refusal as a sentence that says what to do next: more than the code and
 * the message, because the fields that change the decision belong in the line
 * the caller will actually see.
 */
function render(e: Rendered): string {
  let s = "bud: ";
  if (e.httpStatus > 0) s += `${e.httpStatus} `;
  s += e.code;
  if (e.serverMessage) s += `: ${e.serverMessage}`;
  if (e.counter) {
    s += ` [limit ${e.counter}`;
    if (e.retryAfterMs > 0) s += `, retry in ${formatSeconds(e.retryAfterMs)}`;
    s += "]";
  }
  if (e.guard) s += ` [guard ${e.guard}]`;
  if (e.field) s += ` [at ${e.field}]`;
  if (e.hint) s += ` — ${e.hint}`;
  if (e.requestId) s += ` (${e.requestId})`;
  return s;
}

/** A duration rounded to the second, written the way the other SDKs write it: 41m0s, 1h2m3s, 5s. */
function formatSeconds(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}h${m}m${sec}s`;
  if (m > 0) return `${m}m${sec}s`;
  return `${sec}s`;
}

/**
 * A refusal this SDK produced before sending anything. `httpStatus` stays 0,
 * which is how a caller tells "we rejected this" from "the server did".
 */
export function preflight(code: string, message: string): BudError {
  return new BudError({ code, message });
}

/**
 * A refusal read out of a response that is not the envelope — a load balancer's HTML, a
 * proxy's plain text. The status still carries information, so it is kept; a
 * short body is surfaced in the hint, labelled, because it is not the server's
 * own voice.
 */
export function errorFrom(status: number, body: string, requestId: string): BudError {
  const unauthorized = status === 401;
  const out: BudErrorBody = {
    code: unauthorized ? BudErrorCodes.Unauthorized : BudErrorCodes.MalformedResponse,
    message: unauthorized
      ? "the credential was not accepted"
      : "the server's answer was not an envelope",
  };
  const trimmed = body.trim();
  if (trimmed !== "" && new TextEncoder().encode(trimmed).byteLength <= 200) {
    out.hint = `the body was: ${trimmed}`;
  }
  if (requestId) out.request_id = requestId;
  return new BudError(out, status);
}

/**
 * Turn a decoded `error` object into a BudError, or `undefined` when it is not
 * one (not an object, or no string code) — which the caller reports as a
 * malformed response rather than inventing a refusal the server never wrote.
 * The header's request id fills in only when the body carries none.
 */
export function refusalFrom(raw: unknown, status: number, requestId: string): BudError | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.code !== "string") return undefined;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const retry = o.retry_after_ms;
  return new BudError(
    {
      code: o.code,
      message: str(o.message) ?? "",
      hint: str(o.hint),
      request_id: str(o.request_id) || requestId || undefined,
      retry_after_ms: typeof retry === "number" && retry > 0 ? retry : undefined,
      current: o.current,
      version: str(o.version),
      field: str(o.field),
      guard: str(o.guard),
      counter: str(o.counter),
    },
    status,
  );
}
