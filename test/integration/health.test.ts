import { describe, it } from "vitest";
import { REQUEST_TIMEOUT_MS, hasApiKey, newClient } from "./setup.js";

describe.skipIf(!hasApiKey())("Health (integration)", () => {
  it("returns 200", async () => {
    const c = newClient();
    const t0 = Date.now();
    await c.health({ readTimeoutMs: REQUEST_TIMEOUT_MS });
    console.log(`  Health                       ${Date.now() - t0}ms`);
  });

  it("works without an API key (endpoint is unauthenticated per spec)", async () => {
    // /v1/health is `security: []` in the spec; the SDK omits the
    // Authorization header. A bogus key must still succeed.
    const { SemantikClient } = await import("../../src/semantik/index.js");
    const c = new SemantikClient({
      apiKey: "keyu_00000000000000000000000000000000000000000000",
      baseUrl: "https://semantik.noetive.io",
    });
    await c.health({ readTimeoutMs: REQUEST_TIMEOUT_MS });
  });
});
