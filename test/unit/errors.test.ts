import { describe, expect, it } from "vitest";
import {
  APIError,
  AuthenticationError,
  BackpressureError,
  BillingError,
  ErrorCodes,
  InvalidRequestError,
  MethodNotAllowedError,
  MeteringUnavailableError,
  ModelNotProvisionedError,
  NamespaceDisabledError,
  NamespaceUnavailableError,
  NoetiveError,
  RateLimitError,
  RequestTooLargeError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnsupportedMediaTypeError,
  errorFromResponse,
  preflightError,
  preflightTooLarge,
} from "../../src/errors.js";

function hdrs(o: Record<string, string> = {}): Headers {
  return new Headers(o);
}

describe("errorFromResponse — code dispatch", () => {
  it.each([
    [ErrorCodes.InvalidRequest, InvalidRequestError, 400],
    [ErrorCodes.Unauthorized, AuthenticationError, 401],
    [ErrorCodes.NotBillable, BillingError, 402],
    [ErrorCodes.RequestTooLarge, RequestTooLargeError, 413],
    [ErrorCodes.UnsupportedMediaType, UnsupportedMediaTypeError, 415],
    [ErrorCodes.MethodNotAllowed, MethodNotAllowedError, 405],
    [ErrorCodes.RateLimited, RateLimitError, 429],
    [ErrorCodes.TooManyRequests, TooManyRequestsError, 429],
    [ErrorCodes.Backpressure, BackpressureError, 429],
    [ErrorCodes.Unavailable, ServiceUnavailableError, 503],
    [ErrorCodes.NamespaceUnavailable, NamespaceUnavailableError, 503],
    [ErrorCodes.MeteringUnavailable, MeteringUnavailableError, 503],
    [ErrorCodes.NamespaceDisabled, NamespaceDisabledError, 400],
    [ErrorCodes.ModelNotProvisioned, ModelNotProvisionedError, 400],
    [ErrorCodes.InternalError, APIError, 500],
  ])("dispatches code=%s to %s", (code, cls, status) => {
    const err = errorFromResponse(status, hdrs(), { error: code, message: "x" });
    expect(err).toBeInstanceOf(cls);
    expect(err.code).toBe(code);
    expect(err.httpStatus).toBe(status);
  });

  it("falls back to status code when body is empty", () => {
    const err = errorFromResponse(401, hdrs(), undefined);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.code).toBe(ErrorCodes.Unauthorized);
  });

  it("falls back to rate_limited (terminal) on bodyless 429", () => {
    // Deliberate asymmetry: backpressure vs rate-limited cannot be told apart
    // from headers alone, so the fallback picks the terminal of the two.
    const err = errorFromResponse(429, hdrs(), undefined);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err).not.toBeInstanceOf(BackpressureError);
    expect(err.code).toBe(ErrorCodes.RateLimited);
  });

  it("maps bodyless 403 to namespace_disabled", () => {
    // Spec: 403 → namespace_disabled. Without a body code we still want the
    // typed class so callers can `instanceof NamespaceDisabledError`.
    const err = errorFromResponse(403, hdrs(), undefined);
    expect(err).toBeInstanceOf(NamespaceDisabledError);
    expect(err.code).toBe(ErrorCodes.NamespaceDisabled);
  });

  it("maps bodyless 405 to method_not_allowed", () => {
    const err = errorFromResponse(405, hdrs(), undefined);
    expect(err).toBeInstanceOf(MethodNotAllowedError);
    expect(err.code).toBe(ErrorCodes.MethodNotAllowed);
  });

  it("body code wins over status: 403 with invalid_request body → InvalidRequestError", () => {
    // A misbehaving intermediary or future server variant could pair a 403
    // status with a non-namespace body code. The envelope is authoritative
    // per the spec — the typed class follows the code, not the status.
    const err = errorFromResponse(403, hdrs(), {
      error: "invalid_request",
      message: "rerouted",
    });
    expect(err).toBeInstanceOf(InvalidRequestError);
    expect(err).not.toBeInstanceOf(NamespaceDisabledError);
    expect(err.code).toBe(ErrorCodes.InvalidRequest);
    expect(err.httpStatus).toBe(403);
  });

  it("empty error string in body falls through to status fallback", () => {
    // Defensive: if the body parses as JSON but `error` is empty, we should
    // still produce a sensible typed class from the status.
    const err = errorFromResponse(403, hdrs(), { error: "", message: "no code" });
    expect(err).toBeInstanceOf(NamespaceDisabledError);
    expect(err.code).toBe(ErrorCodes.NamespaceDisabled);
  });

  it("body request_id wins over X-Request-Id on 403", () => {
    const err = errorFromResponse(403, hdrs({ "x-request-id": "hdr-id" }), {
      error: "namespace_disabled",
      request_id: "body-id",
    });
    expect(err.requestId).toBe("body-id");
  });

  it("body request_id wins over X-Request-Id on 405", () => {
    const err = errorFromResponse(405, hdrs({ "x-request-id": "hdr-id" }), {
      error: "method_not_allowed",
      request_id: "body-id",
    });
    expect(err.requestId).toBe("body-id");
  });

  it("preserves responseBody verbatim for typed-class errors", () => {
    const body = { error: "namespace_disabled", message: "off", request_id: "r-1" };
    const err = errorFromResponse(403, hdrs(), body);
    expect(err.responseBody).toBe(body);
  });

  it("does not set retry_after_ms on terminal 403/405 when none is sent", () => {
    // 403 namespace_disabled and 405 method_not_allowed are terminal — the
    // spec lists retry_after_ms only on the 503/backpressure family.
    const ns = errorFromResponse(403, hdrs(), { error: "namespace_disabled" });
    expect(ns.retryAfterMs).toBeUndefined();
    const mna = errorFromResponse(405, hdrs(), { error: "method_not_allowed" });
    expect(mna.retryAfterMs).toBeUndefined();
  });
});

describe("errorFromResponse — fields", () => {
  it("carries request_id from body when present", () => {
    const err = errorFromResponse(500, hdrs({ "x-request-id": "hdr-id" }), {
      error: "internal_error",
      message: "boom",
      request_id: "body-id",
    });
    expect(err.requestId).toBe("body-id");
  });

  it("falls back to X-Request-Id header when body lacks request_id", () => {
    const err = errorFromResponse(500, hdrs({ "x-request-id": "hdr-id" }), {
      error: "internal_error",
    });
    expect(err.requestId).toBe("hdr-id");
  });

  it("picks up retry_after_ms from body", () => {
    const err = errorFromResponse(503, hdrs(), {
      error: "unavailable",
      retry_after_ms: 1500,
    });
    expect(err.retryAfterMs).toBe(1500);
  });

  it("caps body retry_after_ms at one hour", () => {
    const err = errorFromResponse(503, hdrs(), {
      error: "unavailable",
      retry_after_ms: 99_999_999_999,
    });
    expect(err.retryAfterMs).toBe(60 * 60 * 1000);
  });

  it("falls back to Retry-After header (delta-seconds)", () => {
    const err = errorFromResponse(503, hdrs({ "retry-after": "5" }), {
      error: "unavailable",
    });
    expect(err.retryAfterMs).toBe(5000);
  });

  it("ignores negative or zero Retry-After", () => {
    const err = errorFromResponse(503, hdrs({ "retry-after": "0" }), {
      error: "unavailable",
    });
    expect(err.retryAfterMs).toBeUndefined();
  });

  it("preserves body excerpt on malformed (non-JSON) body", () => {
    const err = errorFromResponse(502, hdrs(), "<html>Bad Gateway</html>");
    expect(err.message).toContain("Bad Gateway");
  });
});

describe("preflight helpers", () => {
  it("preflightError builds an InvalidRequestError with httpStatus=0", () => {
    const err = preflightError("bad input");
    expect(err).toBeInstanceOf(InvalidRequestError);
    expect(err.httpStatus).toBe(0);
    expect(err.code).toBe(ErrorCodes.InvalidRequest);
  });

  it("preflightTooLarge builds a RequestTooLargeError with httpStatus=0", () => {
    const err = preflightTooLarge("too big");
    expect(err).toBeInstanceOf(RequestTooLargeError);
    expect(err.httpStatus).toBe(0);
  });
});

describe("NoetiveError ergonomics", () => {
  it("subclasses preserve instanceof to NoetiveError", () => {
    const err = new AuthenticationError("nope");
    expect(err).toBeInstanceOf(NoetiveError);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.name).toBe("AuthenticationError");
  });

  it("toString includes request_id when set", () => {
    const err = new APIError("boom", { requestId: "abc" });
    expect(String(err)).toContain("[request_id=abc]");
  });

  it("BackpressureError is a RateLimitError", () => {
    expect(new BackpressureError("x")).toBeInstanceOf(RateLimitError);
  });

  it("unknown 503 codes fall back to ServiceUnavailableError but preserve the wire code", () => {
    // The SDK only enumerates the codes documented in public-api.yaml. Codes
    // outside that set (whether internal or future) must still produce a
    // retryable ServiceUnavailableError so the default retry policy picks
    // them up, with err.code carrying the original string for callers that
    // branch on it.
    const err = errorFromResponse(503, hdrs(), { error: "some_internal_code", message: "x" });
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err.code).toBe("some_internal_code");
  });

  it("NamespaceDisabledError carries its class name on .name", () => {
    const err = new NamespaceDisabledError("disabled");
    expect(err.name).toBe("NamespaceDisabledError");
    expect(err).toBeInstanceOf(NoetiveError);
  });

  it("MethodNotAllowedError carries its class name on .name", () => {
    const err = new MethodNotAllowedError("nope");
    expect(err.name).toBe("MethodNotAllowedError");
    expect(err).toBeInstanceOf(NoetiveError);
  });

  it("C5: unknown error code round-trips through decoder on a non-mapped status", () => {
    // A future code on a status the SDK doesn't recognise: must still
    // produce a NoetiveError (APIError fallback) and preserve the original
    // code string verbatim so callers can branch on it.
    const err = errorFromResponse(599, hdrs(), {
      error: "future_xyz_code",
      message: "from the future",
    });
    expect(err).toBeInstanceOf(NoetiveError);
    expect(err.code).toBe("future_xyz_code");
    expect(err.httpStatus).toBe(599);
    expect(err.message).toBe("from the future");
  });
});
