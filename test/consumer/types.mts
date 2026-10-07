// Type-level consumer check for the `import` condition. Compiled with
// test/consumer/tsconfig.json against the installed package, never the source.
import { Client, type NoetiveError, VERSION } from "@noetive/sdk";
import { BudClient } from "@noetive/sdk/bud";
import type { PublishRequest } from "@noetive/sdk/semantik";

const req: PublishRequest = {
  items: [{ text: "x" }],
  namespace: "global",
  model: "Qwen3-Embedding-4B",
  dimensions: 1024,
};
const version: string = VERSION;
export const checked = [Client, BudClient, req, version] as const;
export type Checked = [NoetiveError, typeof checked];
