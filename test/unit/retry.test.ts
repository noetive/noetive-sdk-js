import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  APIError,
  AuthenticationError,
  BackpressureError,
  InvalidRequestError,
  MeteringUnavailableError,
  MethodNotAllowedError,
  ModelNotProvisionedError,
  NamespaceDisabledError,
  NamespaceUnavailableError,
  RateLimitError,
  ServiceUnavailableError,
  TooManyRequestsError,
  TransportError,
} from "../../src/errors.js";
import {
  BackoffSchedulePolicy,
  DEFAULT_BACKOFF_SCHEDULE_MS,
  DEFAULT_RETRY_POLICY,
  noRetry,
} from "../../src/retry.js";

describe("BackoffSchedulePolicy.delayFor — retryable classification", () => {
  const policy = new BackoffSchedulePolicy();

  it("retries RateLimitError family", () => {
    expect(policy.delayFor(new RateLimitError("x", { httpStatus: 429 }), 1)).toBe(100);
    expect(policy.delayFor(new TooManyRequestsError("x", { httpStatus: 429 }), 1)).toBe(100);
    expect(policy.delayFor(new BackpressureError("x", { httpStatus: 429 }), 1)).toBe(100);
  });

  it("retries ServiceUnavailableError and its subclasses", () => {
    expect(policy.delayFor(new ServiceUnavailableError("x", { httpStatus: 503 }), 1)).toBe(100);
  });

  it("retries TransportError", () => {
    expect(policy.delayFor(new TransportError("boom"), 1)).toBe(100);
  });

  it("does NOT retry 4xx client errors", () => {
    expect(policy.delayFor(new InvalidRequestError("x", { httpStatus: 400 }), 1)).toBeNull();
    expect(policy.delayFor(new AuthenticationError("x", { httpStatus: 401 }), 1)).toBeNull();
  });

  it("does NOT retry APIError (internal_error) by default", () => {
    expect(policy.delayFor(new APIError("x", { httpStatus: 500 }), 1)).toBeNull();
  });

  it("does NOT retry preflight errors (httpStatus === 0)", () => {
    expect(policy.delayFor(new InvalidRequestError("x", { httpStatus: 0 }), 1)).toBeNull();
  });

  it("retries NamespaceUnavailableError (503 family)", () => {
    expect(policy.delayFor(new NamespaceUnavailableError("x", { httpStatus: 503 }), 1)).toBe(100);
  });

  it("retries MeteringUnavailableError (503 family)", () => {
    expect(policy.delayFor(new MeteringUnavailableError("x", { httpStatus: 503 }), 1)).toBe(100);
  });

  it("does NOT retry NamespaceDisabledError (403 terminal)", () => {
    // Namespace administratively disabled — retries never help; admin action
    // is required. Must be terminal regardless of whether retry_after_ms
    // somehow appears on the wire.
    expect(
      policy.delayFor(new NamespaceDisabledError("disabled", { httpStatus: 403 }), 1),
    ).toBeNull();
    expect(
      policy.delayFor(
        new NamespaceDisabledError("disabled", { httpStatus: 403, retryAfterMs: 1000 }),
        1,
      ),
    ).toBeNull();
  });

  it("does NOT retry MethodNotAllowedError (405 terminal)", () => {
    // 405 indicates a client-side or proxy bug. The SDK only sends POST, so
    // a 405 means something else has gone wrong; retrying just amplifies it.
    expect(policy.delayFor(new MethodNotAllowedError("nope", { httpStatus: 405 }), 1)).toBeNull();
  });
});

// model_not_provisioned is returned both while a pairing is still
// becoming ready and for one that will never exist. The retry hint is
// the only thing separating them, so pin both sides of the gate.
describe("BackoffSchedulePolicy.delayFor — model_not_provisioned hint gate", () => {
  const policy = new BackoffSchedulePolicy();

  it("does NOT retry without a hint", () => {
    expect(
      policy.delayFor(new ModelNotProvisionedError("mismatch", { httpStatus: 400 }), 1),
    ).toBeNull();
  });

  it("retries at the server's hint when one is present", () => {
    expect(
      policy.delayFor(
        new ModelNotProvisionedError("warming", { httpStatus: 400, retryAfterMs: 2000 }),
        1,
      ),
    ).toBe(2000);
  });

  it("never falls back to the backoff schedule on later attempts", () => {
    // A hinted error must keep using the hint; drifting onto the table
    // would erase the distinction the hint encodes.
    const err = new ModelNotProvisionedError("warming", {
      httpStatus: 400,
      retryAfterMs: 2000,
    });
    expect(policy.delayFor(err, 3)).toBe(2000);
  });

  it("still respects maxAttempts", () => {
    const bounded = new BackoffSchedulePolicy({ maxAttempts: 2 });
    const err = new ModelNotProvisionedError("warming", {
      httpStatus: 400,
      retryAfterMs: 500,
    });
    expect(bounded.delayFor(err, 1)).toBe(500);
    expect(bounded.delayFor(err, 2)).toBeNull();
  });

  it("treats a zero hint as no hint", () => {
    expect(
      policy.delayFor(new ModelNotProvisionedError("x", { httpStatus: 400, retryAfterMs: 0 }), 1),
    ).toBeNull();
  });

  // Opt-in is enforced by the existing NamespaceDisabledError case in
  // the classification block above: it carries a retryAfterMs and still
  // returns null, because it never sets `retriableWithHint`.
});

describe("C1: default backoff schedule", () => {
  const policy = new BackoffSchedulePolicy();

  it("C1: default schedule is [100, 2000, 5000, 10000] for attempts 1..4", () => {
    const err = () => new ServiceUnavailableError("x", { httpStatus: 503 });
    expect(policy.delayFor(err(), 1)).toBe(100);
    expect(policy.delayFor(err(), 2)).toBe(2000);
    expect(policy.delayFor(err(), 3)).toBe(5000);
    expect(policy.delayFor(err(), 4)).toBe(10_000);
  });

  it("C1: schedule saturates at 10000ms for attempts > schedule.length", () => {
    // maxAttempts default is 6 — attempt 5 still allowed, and stays at 10s.
    const err = new ServiceUnavailableError("x", { httpStatus: 503 });
    expect(policy.delayFor(err, 5)).toBe(10_000);
  });

  it("C1: server retry_after_ms still overrides the table", () => {
    const err = new BackpressureError("x", { httpStatus: 429, retryAfterMs: 250 });
    expect(policy.delayFor(err, 1)).toBe(250);
    expect(policy.delayFor(err, 3)).toBe(250);
  });

  it("stops at maxAttempts (default 6)", () => {
    const err = new ServiceUnavailableError("x", { httpStatus: 503 });
    expect(policy.delayFor(err, 6)).toBeNull();
    expect(policy.delayFor(err, 10)).toBeNull();
  });
});

describe("BackoffSchedulePolicy — custom schedule", () => {
  it("honours a caller-supplied schedule and saturates at its last entry", () => {
    const p = new BackoffSchedulePolicy({ schedule: [50, 200, 800], maxAttempts: 10 });
    const err = new ServiceUnavailableError("x", { httpStatus: 503 });
    expect(p.delayFor(err, 1)).toBe(50);
    expect(p.delayFor(err, 2)).toBe(200);
    expect(p.delayFor(err, 3)).toBe(800);
    // Past the table — saturates at max(last, 10_000) = 10_000.
    expect(p.delayFor(err, 4)).toBe(10_000);
  });

  it("accepts a flat schedule for fast tests", () => {
    const p = new BackoffSchedulePolicy({ schedule: [1, 1, 1, 1], maxAttempts: 5 });
    const err = new ServiceUnavailableError("x", { httpStatus: 503 });
    expect(p.delayFor(err, 1)).toBe(1);
    expect(p.delayFor(err, 4)).toBe(1);
  });
});

describe("BackoffSchedulePolicy property: backoff is bounded and non-decreasing", () => {
  it("delay never exceeds the maximum of the schedule and the saturation cap", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 30_000 }), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 1, max: 50 }),
        (schedule, attempt) => {
          const p = new BackoffSchedulePolicy({ schedule, maxAttempts: 100 });
          const d = p.delayFor(new ServiceUnavailableError("x", { httpStatus: 503 }), attempt);
          if (d === null) return true;
          const cap = Math.max(...schedule, 10_000);
          return d >= 0 && d <= cap;
        },
      ),
    );
  });

  it("delay is non-decreasing with attempt index when schedule is non-decreasing", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 }), (n) => {
        const p = new BackoffSchedulePolicy({
          schedule: [100, 200, 500, 1000],
          maxAttempts: 100,
        });
        let prev = -1;
        for (let i = 1; i <= n; i++) {
          const d = p.delayFor(new ServiceUnavailableError("x", { httpStatus: 503 }), i);
          if (d === null) return true;
          if (d < prev) return false;
          prev = d;
        }
        return true;
      }),
    );
  });
});

describe("noRetry", () => {
  it("returns null for every input", () => {
    const p = noRetry();
    expect(p.delayFor(new ServiceUnavailableError("x", { httpStatus: 503 }), 1)).toBeNull();
    expect(p.delayFor(new TransportError("x"), 5)).toBeNull();
  });
});

describe("DEFAULT_RETRY_POLICY", () => {
  it("is a BackoffSchedulePolicy with maxAttempts 6", () => {
    expect((DEFAULT_RETRY_POLICY as BackoffSchedulePolicy).maxAttempts).toBe(6);
  });

  it("uses the documented [100, 2000, 5000, 10000] default schedule", () => {
    expect(Array.from(DEFAULT_BACKOFF_SCHEDULE_MS)).toEqual([100, 2000, 5000, 10_000]);
  });
});
