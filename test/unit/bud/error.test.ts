import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BudError, BudErrorCodes } from "../../../src/bud/index.js";
import { ErrorCodes, NoetiveError } from "../../../src/errors.js";

describe("a refusal reads as a plan", () => {
  it("renders the status, code, limit, wait, hint and request id in the line a caller sees", () => {
    const e = new BudError(
      {
        code: BudErrorCodes.RateLimited,
        message: "the per_hour limit is used up",
        counter: "per_hour",
        retry_after_ms: 41 * 60 * 1000,
        hint: "wait for the window to reset",
        request_id: "request_01x",
      },
      429,
    );
    expect(e.message).toBe(
      "bud: 429 rate_limited: the per_hour limit is used up [limit per_hour, retry in 41m0s]" +
        " — wait for the window to reset (request_01x)",
    );
    expect(e.retryAfterMs).toBe(41 * 60 * 1000);
    expect(e.retryable()).toBe(true);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("BudError");
  });

  it("renders a guard and a field, and leaves out a status it never had", () => {
    expect(new BudError({ code: "policy_refused", message: "no", guard: "virus" }).message).toBe(
      "bud: policy_refused: no [guard virus]",
    );
    expect(new BudError({ code: "invalid", message: "bad", field: "/attach" }).message).toBe(
      "bud: invalid: bad [at /attach]",
    );
    expect(
      new BudError({ code: "rate_limited", message: "", counter: "c", retry_after_ms: 3_725_000 })
        .message,
    ).toBe("bud: rate_limited [limit c, retry in 1h2m5s]");
  });
});

describe("retryable follows the server's advice", () => {
  const table: [string, boolean][] = [
    [BudErrorCodes.UpstreamUnavailable, true],
    [BudErrorCodes.PreconditionFailed, true],
    [BudErrorCodes.Internal, true],
    [BudErrorCodes.Paused, false],
    [BudErrorCodes.NotBillable, false],
    [BudErrorCodes.Unavailable, false],
    [BudErrorCodes.Unauthorized, false],
    [BudErrorCodes.ForbiddenScope, false],
    [BudErrorCodes.NotFound, false],
    [BudErrorCodes.PolicyRefused, false],
    [BudErrorCodes.Invalid, false],
    [BudErrorCodes.MalformedResponse, false],
    [BudErrorCodes.RateLimited, false],
  ];
  for (const [code, want] of table) {
    it(`${code} → ${want}`, () => {
      expect(new BudError({ code, message: "" }).retryable()).toBe(want);
    });
  }

  it("covers all thirteen codes", () => {
    expect(new Set(table.map(([c]) => c))).toEqual(new Set(Object.values(BudErrorCodes)));
  });

  it("a rate limit is worth waiting out exactly when the server says how long", () => {
    fc.assert(
      fc.property(fc.nat(), (ms) => {
        const e = new BudError({ code: "rate_limited", message: "", retry_after_ms: ms });
        return e.retryable() === ms > 0;
      }),
    );
  });
});

describe("Bud's codes stay Bud's", () => {
  it("is not a platform NoetiveError, so platform retry policies never see it", () => {
    expect(new BudError({ code: "unavailable", message: "" })).not.toBeInstanceOf(NoetiveError);
  });

  it("does not change what the platform codes mean", () => {
    expect(ErrorCodes.Unavailable).toBe("unavailable");
    expect(Object.values(ErrorCodes)).not.toContain("forbidden_scope");
  });

  it("matches by code", () => {
    const e = new BudError({ code: "not_found", message: "" });
    expect(BudError.is(e, BudErrorCodes.NotFound)).toBe(true);
    expect(BudError.is(e, BudErrorCodes.Invalid)).toBe(false);
    expect(BudError.is(e)).toBe(true);
    expect(BudError.is(new Error("x"))).toBe(false);
  });
});
