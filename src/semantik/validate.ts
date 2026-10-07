/**
 * Pre-flight validators for the Semantik request payloads.
 *
 * Each validator throws an `InvalidRequestError` with `httpStatus === 0`
 * to signal that the SDK rejected the request before sending it. The rules
 * mirror the server's acceptance criteria so callers get fast, local
 * feedback for the easy mistakes (mismatched dims, oversized metadata,
 * NaN in a vector) without burning a network round trip.
 */

import { preflightError } from "../errors.js";
import {
  MAX_METADATA_KEYS,
  MAX_METADATA_KEY_LEN,
  MAX_METADATA_TOTAL_BYTES,
  MAX_METADATA_VALUE_LEN,
  MAX_TEXT_BYTES,
  MAX_VECTOR_DIM,
} from "./defaults.js";
import type {
  LintRequest,
  PublishItem,
  PublishRequest,
  SearchRequest,
  SubscribeRequest,
} from "./models.js";

const utf8 = new TextEncoder();

/**
 * Reject strings containing lone surrogate halves — encoding such strings to
 * the wire silently replaces them with U+FFFD, which would round-trip
 * differently on the server. Uses `String.prototype.isWellFormed` (Node 20+,
 * Bun, Deno, modern browsers) when available; falls back to a manual surrogate
 * scan otherwise. Mirrors Go's `utf8.ValidString` checks.
 */
function isWellFormedString(s: string): boolean {
  const fn = (s as unknown as { isWellFormed?: () => boolean }).isWellFormed;
  if (typeof fn === "function") return fn.call(s);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      // High surrogate must be followed by a low surrogate.
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false; // Lone low surrogate.
    }
  }
  return true;
}

export function validateApiKey(key: string): void {
  if (!key) throw preflightError("API key must not be empty");
}

/**
 * Enforce the three targeting fields every publish/search/subscribe request
 * must carry: a non-empty `namespace`, a non-empty `model`, and an in-range
 * `dimensions`.
 *
 * The SDK does not default these. Routing a request to a namespace the caller
 * never named — silently falling back to a shared one — risks publishing
 * sensitive data into a space it was not meant for, so an unset field is a
 * fail-fast preflight error rather than a convenience default. `model` and
 * `dimensions` are likewise model-coupled properties with no server default.
 */
function validateTarget(
  namespace: string | undefined,
  model: string | undefined,
  dimensions: number | undefined,
): void {
  if (!namespace || namespace.length === 0) {
    throw preflightError("namespace must not be empty");
  }
  if (!model || model.length === 0) {
    throw preflightError("model must not be empty");
  }
  validateDimensions(dimensions);
}

function validateDimensions(dim: number | undefined): void {
  if (dim === undefined || dim <= 0) {
    throw preflightError("dimensions must be greater than 0");
  }
  if (!Number.isInteger(dim)) {
    throw preflightError("dimensions must be a positive integer");
  }
  if (dim > MAX_VECTOR_DIM) {
    throw preflightError(`dimensions ${dim} exceeds maximum ${MAX_VECTOR_DIM}`);
  }
}

function validateMetadata(md: Record<string, string> | undefined): void {
  if (!md) return;
  const entries = Object.entries(md);
  if (entries.length === 0) return;
  if (entries.length > MAX_METADATA_KEYS) {
    throw preflightError(`metadata has ${entries.length} keys, maximum ${MAX_METADATA_KEYS}`);
  }
  let total = 0;
  for (const [k, v] of entries) {
    if (k.length === 0) {
      throw preflightError("metadata key must not be empty");
    }
    if (typeof v !== "string") {
      throw preflightError(`metadata value for key ${JSON.stringify(k)} must be a string`);
    }
    if (!isWellFormedString(k)) {
      throw preflightError(`metadata key ${JSON.stringify(k)} is not valid UTF-8`);
    }
    if (!isWellFormedString(v)) {
      throw preflightError(`metadata value for key ${JSON.stringify(k)} is not valid UTF-8`);
    }
    const kChars = codePointLength(k);
    const vChars = codePointLength(v);
    if (kChars > MAX_METADATA_KEY_LEN) {
      throw preflightError(
        `metadata key ${JSON.stringify(k)} exceeds ${MAX_METADATA_KEY_LEN} characters`,
      );
    }
    if (vChars > MAX_METADATA_VALUE_LEN) {
      throw preflightError(
        `metadata value for key ${JSON.stringify(k)} exceeds ${MAX_METADATA_VALUE_LEN} characters`,
      );
    }
    if (hasControlChar(k)) {
      throw preflightError(`metadata key ${JSON.stringify(k)} contains control characters`);
    }
    if (hasControlChar(v)) {
      throw preflightError(
        `metadata value for key ${JSON.stringify(k)} contains control characters`,
      );
    }
    total += utf8.encode(k).byteLength + utf8.encode(v).byteLength;
  }
  if (total > MAX_METADATA_TOTAL_BYTES) {
    throw preflightError(`metadata total size ${total} exceeds ${MAX_METADATA_TOTAL_BYTES} bytes`);
  }
}

function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function validatePublishItem(item: PublishItem): void {
  const hasText = typeof item.text === "string" && item.text.length > 0;
  const hasVector = Array.isArray(item.vector) && item.vector.length > 0;
  if (!hasText && !hasVector) {
    throw preflightError("publish item must have at least one of text or vector");
  }
  if (hasText) {
    const text = item.text as string;
    if (!isWellFormedString(text)) {
      throw preflightError("publish text is not valid UTF-8");
    }
    const textBytes = utf8.encode(text).byteLength;
    if (textBytes > MAX_TEXT_BYTES) {
      throw preflightError(`publish text exceeds ${MAX_TEXT_BYTES} bytes`);
    }
  }
  if (hasVector) {
    const v = item.vector as number[];
    if (v.length > MAX_VECTOR_DIM) {
      throw preflightError(`publish vector length ${v.length} exceeds maximum ${MAX_VECTOR_DIM}`);
    }
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      // `Number.isFinite` excludes NaN, ±Infinity, and non-numbers in one shot.
      if (!Number.isFinite(x)) {
        throw preflightError(`publish vector index ${i} is NaN or Infinity`);
      }
    }
  }
}

export function validatePublishRequest(req: PublishRequest): void {
  validateTarget(req.namespace, req.model, req.dimensions);
  if (!Array.isArray(req.items) || req.items.length !== 1) {
    throw preflightError(
      `publish requires exactly 1 item, got ${Array.isArray(req.items) ? req.items.length : 0}`,
    );
  }
  validatePublishItem(req.items[0]);
  // Check vector ↔ dimensions agreement (server checks this; failing fast is friendlier).
  const vec = req.items[0].vector;
  if (Array.isArray(vec) && vec.length > 0 && vec.length !== req.dimensions) {
    throw preflightError(
      `publish vector length ${vec.length} does not match dimensions ${req.dimensions}`,
    );
  }
  validateMetadata(req.metadata);
  if (req.ack !== undefined && req.ack !== "stored" && req.ack !== "durable") {
    throw preflightError(`ack ${JSON.stringify(req.ack)} is not a valid AckMode`);
  }
}

export function validateSearchRequest(req: SearchRequest): void {
  if (!req.query || req.query.length === 0) {
    throw preflightError("search query must not be empty");
  }
  validateTarget(req.namespace, req.model, req.dimensions);
  if (req.limit !== undefined && req.limit < 0) {
    throw preflightError("search limit must not be negative");
  }
}

export function validateSubscribeRequest(req: SubscribeRequest): void {
  if (!req.query || req.query.length === 0) {
    throw preflightError("subscribe query must not be empty");
  }
  validateTarget(req.namespace, req.model, req.dimensions);
}

export function validateLintRequest(req: LintRequest): void {
  if (!req.query || req.query.length === 0) {
    throw preflightError("lint query must not be empty");
  }
  if (req.cursor !== undefined) {
    if (req.cursor < 0) {
      throw preflightError("lint cursor must not be negative");
    }
    // Spec: `cursor` is a UTF-8 byte offset. JS `string.length` counts UTF-16
    // code units, so encode to bytes before bounds-checking — otherwise a
    // query with any non-ASCII character would mis-report the upper bound.
    const queryBytes = utf8.encode(req.query).byteLength;
    if (req.cursor > queryBytes) {
      throw preflightError(
        `lint cursor ${req.cursor} out of bounds (query byte length ${queryBytes})`,
      );
    }
  }
}
