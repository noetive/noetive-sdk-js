/**
 * Integration test harness.
 *
 * Hits the production endpoint `https://semantik.noetive.io` directly so the
 * suite catches drift between the SDK and the real server. The base URL is
 * hardcoded — an override would defeat the point.
 *
 * Required environment:
 *   NOETIVE_KEY_SECRET — a valid production API key from the Noetive dashboard
 *
 * Tests are gated on `NOETIVE_KEY_SECRET` so `vitest run` stays green offline.
 *
 * Every publish uses a fresh idempotency key so the suite is safe to re-run
 * against shared server state.
 */

import { randomBytes } from "node:crypto";
import { SemantikClient } from "../../src/semantik/index.js";

export const PROD_BASE_URL = "https://semantik.noetive.io";

export const TEST_NAMESPACE = "global";
export const TEST_MODEL = "Qwen3-Embedding-4B";
export const TEST_DIMS = 1024;

/** Each individual SDK call timeout. Leaves room for retry backoffs. */
export const REQUEST_TIMEOUT_MS = 45_000;

/** Subscribe-specific budgets. */
export const SUBSCRIBE_SETUP_MS = 30_000;
export const SUBSCRIBE_DELIVERY_MS = 15_000;

export const hasApiKey = (): boolean => {
  const k = process.env.NOETIVE_KEY_SECRET;
  return typeof k === "string" && k.length > 0;
};

export function newClient(): SemantikClient {
  const apiKey = process.env.NOETIVE_KEY_SECRET;
  if (!apiKey) throw new Error("NOETIVE_KEY_SECRET not set");
  return new SemantikClient({ apiKey, baseUrl: PROD_BASE_URL });
}

/** Fresh idempotency key per publish — safe to re-run the suite. */
export function newIdempotencyKey(): string {
  return `sdk-it-js-${randomBytes(16).toString("hex")}`;
}

/** Deterministic unit-ish vector for publish tests that don't care about semantics. */
export function unitVector(dim: number): number[] {
  const v = new Array<number>(dim);
  for (let i = 0; i < dim; i++) v[i] = (i % 100) / 100;
  return v;
}
