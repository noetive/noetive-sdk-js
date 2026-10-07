// CommonJS half of the consumer smoke test: the `require` condition of every
// export must resolve and behave like the ESM build. Request round-trips are
// left to smoke.mjs.
const assert = require("node:assert/strict");
const { InvalidRequestError, NoetiveError, VERSION } = require("@noetive/sdk");
const { BudClient } = require("@noetive/sdk/bud");
const { SemantikClient } = require("@noetive/sdk/semantik");
const pkg = require("@noetive/sdk/package.json");

// CommonJS has no top-level await: if the check below never settles the process
// would drain and exit 0, so failure is the default until it completes.
process.exitCode = 1;

assert.equal(VERSION, pkg.version, "VERSION must match the published package.json version");
assert.equal(typeof BudClient, "function", "@noetive/sdk/bud must export BudClient");

let fetchCalls = 0;
const offline = new SemantikClient({
  apiKey: "consumer-smoke",
  fetch: () => {
    fetchCalls++;
    throw new Error("preflight sent a request");
  },
});

assert
  .rejects(
    offline.publish({ items: [{ text: "x" }], model: "Qwen3-Embedding-4B", dimensions: 1024 }),
    (err) =>
      err instanceof InvalidRequestError &&
      err instanceof NoetiveError &&
      err.httpStatus === 0 &&
      /namespace/.test(err.message),
  )
  .then(() => {
    assert.equal(fetchCalls, 0, "preflight rejection must not reach fetch");
    process.exitCode = 0;
    console.log(`cjs ok: @noetive/sdk ${VERSION}`);
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
