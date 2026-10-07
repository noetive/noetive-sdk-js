// Consumer smoke test for the packed tarball, run from a project that installed
// it with npm, pnpm, Yarn or Bun. Exercises the package exactly as a customer
// resolves it: through `exports`, not the source tree. Requests go to a local
// stub so a service outage cannot fail a packaging check; the live contract is
// the integration job's concern.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { InvalidRequestError, NoetiveError, VERSION } from "@noetive/sdk";
import { BudClient } from "@noetive/sdk/bud";
import pkg from "@noetive/sdk/package.json" with { type: "json" };
import { SemantikClient } from "@noetive/sdk/semantik";

assert.equal(VERSION, pkg.version, "VERSION must match the published package.json version");
assert.equal(typeof BudClient, "function", "@noetive/sdk/bud must export BudClient");

// A request without targeting must be refused locally with nothing sent, and
// the error must be the root package's class even though it came from a sub-path.
let fetchCalls = 0;
const offline = new SemantikClient({
  apiKey: "consumer-smoke",
  fetch: () => {
    fetchCalls++;
    throw new Error("preflight sent a request");
  },
});
await assert.rejects(
  offline.publish({ items: [{ text: "x" }], model: "Qwen3-Embedding-4B", dimensions: 1024 }),
  (err) =>
    err instanceof InvalidRequestError &&
    err instanceof NoetiveError &&
    err.httpStatus === 0 &&
    /namespace/.test(err.message),
);
assert.equal(fetchCalls, 0, "preflight rejection must not reach fetch");

// Round-trip through the runtime's own fetch, transport and JSON decoding.
const seen = [];
const server = createServer((req, res) => {
  seen.push({ path: req.url, userAgent: req.headers["user-agent"] });
  res.setHeader("content-type", "application/json");
  if (req.method === "POST" && req.url === "/v1/health") {
    res.end("{}");
  } else if (req.method === "POST" && req.url === "/v1/lint") {
    res.end(JSON.stringify({ valid: true, normalized: 'MATCH DISTANCE("x") WITHIN 0.4' }));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { code: "not_found", message: req.url } }));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const { port } = server.address();
  const stub = new SemantikClient({
    apiKey: "consumer-smoke",
    baseUrl: `http://127.0.0.1:${port}`,
  });
  await stub.health();
  const res = await stub.lint({ query: 'MATCH DISTANCE("x") WITHIN 0.4' });
  assert.equal(res.valid, true, "lint response must decode");
  assert.deepEqual(
    seen.map((s) => s.path),
    ["/v1/health", "/v1/lint"],
  );
  for (const { userAgent } of seen) {
    assert.ok(
      userAgent?.startsWith(`noetive-sdk-js/${VERSION} (`),
      `User-Agent must identify the SDK release, got ${userAgent}`,
    );
  }
} finally {
  server.close();
}

console.log(`esm ok: @noetive/sdk ${VERSION}`);
