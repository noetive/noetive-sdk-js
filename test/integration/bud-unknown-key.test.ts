/**
 * An unknown key needs no valid one: the refusal is the answer, carried on the
 * output with its status and request id. Kept apart from bud.test.ts so it
 * runs without that suite's setup.
 */

import { describe, expect, it } from "vitest";
import { BudClient, BudErrorCodes } from "../../src/bud/index.js";
import { BUD_PROD_BASE_URL, call, hasBudKey, refused } from "./bud-setup.js";

describe.skipIf(!hasBudKey())("Bud with an unknown key (integration)", () => {
  it("is refused as a value", async () => {
    const c = new BudClient({
      apiKey: "keya_not_a_real_key_0000000000000000",
      baseUrl: BUD_PROD_BASE_URL,
    });
    const h = await c.health(call());
    const e = refused("health", h.error, BudErrorCodes.Unauthorized);
    expect(e.httpStatus).toBe(401);
  });
});
