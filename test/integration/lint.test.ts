import { describe, expect, it } from "vitest";
import { REQUEST_TIMEOUT_MS, hasApiKey, newClient } from "./setup.js";

describe.skipIf(!hasApiKey())("Lint (integration)", () => {
  it("accepts a valid SemQL query", async () => {
    const c = newClient();
    const t0 = Date.now();
    const res = await c.lint(
      { query: 'MATCH DISTANCE("machine learning") WITHIN 0.4 LIMIT 5' },
      { readTimeoutMs: REQUEST_TIMEOUT_MS },
    );
    console.log(`  Lint valid                   ${Date.now() - t0}ms`);
    expect(res.valid).toBe(true);
    expect(res.normalized?.length ?? 0).toBeGreaterThan(0);
  });

  it("flags an invalid SemQL query with diagnostics", async () => {
    const c = newClient();
    const t0 = Date.now();
    const res = await c.lint(
      { query: 'MATCH DISTANCE("x") WITHIN not-a-number' },
      { readTimeoutMs: REQUEST_TIMEOUT_MS },
    );
    console.log(`  Lint invalid                 ${Date.now() - t0}ms`);
    expect(res.valid).toBeFalsy();
    expect(res.diagnostics?.length ?? 0).toBeGreaterThan(0);
  });

  it("returns completions for a cursor positioned inside a partial query", async () => {
    // Mirrors the spec example: cursor placed where the next token is
    // expected. The server must respond with at least one completion.
    const c = newClient();
    const query = 'MATCH DISTANCE("climate change") WITHIN ';
    const res = await c.lint(
      { query, cursor: query.length },
      { readTimeoutMs: REQUEST_TIMEOUT_MS },
    );
    expect(Array.isArray(res.completions)).toBe(true);
    expect((res.completions?.length ?? 0)).toBeGreaterThan(0);
  });

  it("accepts a cursor measured in UTF-8 bytes, not UTF-16 code units", async () => {
    // The SemQL anchor contains a multi-byte character ("é" = 2 UTF-8 bytes).
    // The spec defines `cursor` as a byte offset; the SDK's pre-flight check
    // matches that. Verify the server accepts the same byte offset without
    // returning `invalid_request`.
    const c = newClient();
    const query = 'MATCH DISTANCE("café") WITHIN ';
    const byteLen = new TextEncoder().encode(query).byteLength;
    const res = await c.lint(
      { query, cursor: byteLen },
      { readTimeoutMs: REQUEST_TIMEOUT_MS },
    );
    // The exact validity of this partial query is server-defined — what we
    // care about is that the cursor itself does not provoke an error.
    expect(res).toBeDefined();
    expect(typeof res.valid).toBe("boolean");
  });

  it("works without an API key (endpoint is unauthenticated per spec)", async () => {
    // The spec marks /v1/lint as `security: []`. The SDK omits Authorization
    // on that call; sending a deliberately bogus key should still succeed.
    const { SemantikClient } = await import("../../src/semantik/index.js");
    const c = new SemantikClient({
      apiKey: "keyu_00000000000000000000000000000000000000000000",
      baseUrl: "https://semantik.noetive.io",
    });
    const res = await c.lint(
      { query: 'MATCH DISTANCE("x") WITHIN 0.5' },
      { readTimeoutMs: REQUEST_TIMEOUT_MS },
    );
    expect(res.valid).toBe(true);
  });
});
