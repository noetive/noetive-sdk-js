// Type-level consumer check for the `require` condition.
import sdk = require("@noetive/sdk");
import semantik = require("@noetive/sdk/semantik");

const req: semantik.SearchRequest = {
  query: 'MATCH DISTANCE("x") WITHIN 0.4',
  namespace: "global",
  model: "Qwen3-Embedding-4B",
  dimensions: 1024,
};
const version: string = sdk.VERSION;
export type Checked = [typeof sdk.Client, typeof req, typeof version];
