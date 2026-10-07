#!/usr/bin/env node
/**
 * Debug recorder for the Noetive SDK.
 *
 * Prints the full HTTP exchange — method, URL, request headers (with the
 * bearer token redacted), request body, response status, response headers,
 * response body — for each subcommand. Use it to capture wire bytes that
 * accompany a bug report or to verify what the SDK actually sends after a
 * code change.
 *
 * Subcommands mirror the Go SDK's `cmd/recorder` so reports remain
 * comparable across SDK families:
 *
 *   recorder health
 *   recorder lint "MATCH DISTANCE(\"x\") WITHIN 0.4"
 *   recorder publish-text "hello world"
 *   recorder publish-vector
 *   recorder search "MATCH DISTANCE(\"x\") WITHIN 0.4 LIMIT 3"
 *   recorder subscribe "MATCH DISTANCE(\"x\") WITHIN 0.5" [maxEvents]
 *   recorder raw POST /v1/whatever '{"foo":"bar"}'
 *
 * Required env: NOETIVE_KEY_SECRET. Optional: NOETIVE_BASE_URL.
 */

import { randomBytes } from "node:crypto";
import process from "node:process";
import { buildUserAgent } from "../src/userAgent.js";

// The SDK does not default the targeting tuple, so this recorder names the
// `global` namespace's model and dimensions explicitly for its fixtures.
const RECORD_MODEL = "Qwen3-Embedding-4B";
const RECORD_DIMENSIONS = 1024;

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
  printUsage();
  process.exit(args.length === 0 ? 1 : 0);
}

const apiKey = process.env.NOETIVE_KEY_SECRET;
if (!apiKey) {
  console.error("error: NOETIVE_KEY_SECRET is not set");
  process.exit(2);
}
const baseUrl = (process.env.NOETIVE_BASE_URL ?? "https://semantik.noetive.io").replace(/\/$/, "");

const [cmd, ...rest] = args;

switch (cmd) {
  case "health":
    await recordJson({ path: "/v1/health", auth: false, body: {} });
    break;
  case "lint":
    await recordJson({
      path: "/v1/lint",
      auth: false,
      body: { query: rest.join(" ") || 'MATCH DISTANCE("machine learning") WITHIN 0.4 LIMIT 5' },
    });
    break;
  case "publish-text":
    await recordJson({
      path: "/v1/publish",
      auth: true,
      body: {
        items: [{ text: rest.join(" ") || "recorder text message" }],
        namespace: "global",
        model: RECORD_MODEL,
        dimensions: RECORD_DIMENSIONS,
        idempotency_key: `recorder-${randomBytes(8).toString("hex")}`,
      },
    });
    break;
  case "publish-vector": {
    const vector = Array.from({ length: RECORD_DIMENSIONS }, (_, i) => (i % 100) / 100);
    await recordJson({
      path: "/v1/publish",
      auth: true,
      body: {
        items: [{ vector }],
        namespace: "global",
        model: RECORD_MODEL,
        dimensions: RECORD_DIMENSIONS,
        idempotency_key: `recorder-${randomBytes(8).toString("hex")}`,
      },
    });
    break;
  }
  case "search":
    await recordJson({
      path: "/v1/search",
      auth: true,
      body: {
        query: rest.join(" ") || 'MATCH DISTANCE("transformer") WITHIN 0.6 LIMIT 5',
        namespace: "global",
        model: RECORD_MODEL,
        dimensions: RECORD_DIMENSIONS,
      },
    });
    break;
  case "subscribe": {
    const query = rest[0] ?? 'MATCH DISTANCE("mechanical engineering") WITHIN 0.6';
    const max = Number.parseInt(rest[1] ?? "3", 10);
    await recordSse({
      path: "/v1/subscribe",
      body: {
        query,
        namespace: "global",
        model: RECORD_MODEL,
        dimensions: RECORD_DIMENSIONS,
      },
      maxEvents: Number.isFinite(max) ? max : 3,
    });
    break;
  }
  case "raw": {
    if (rest.length < 2) {
      console.error("error: raw expects: raw <METHOD> <PATH> [BODY_JSON]");
      process.exit(2);
    }
    const [_method, _path, ...bodyParts] = rest;
    const bodyText = bodyParts.join(" ");
    await recordRaw({
      method: _method.toUpperCase(),
      path: _path,
      body: bodyText.length > 0 ? bodyText : undefined,
    });
    break;
  }
  default:
    console.error(`error: unknown subcommand "${cmd}"`);
    printUsage();
    process.exit(2);
}

function printUsage(): void {
  console.error(
    `Usage:
  recorder health
  recorder lint "<query>"
  recorder publish-text "<text>"
  recorder publish-vector
  recorder search "<query>"
  recorder subscribe "<query>" [maxEvents]
  recorder raw <METHOD> <PATH> [BODY_JSON]

Env:
  NOETIVE_KEY_SECRET  (required)
  NOETIVE_BASE_URL    (default: https://semantik.noetive.io)`,
  );
}

interface RecordOpts {
  path: string;
  auth: boolean;
  body: unknown;
}

async function recordJson(opts: RecordOpts): Promise<void> {
  const headers = jsonHeaders(opts.auth);
  const bodyBytes = new TextEncoder().encode(JSON.stringify(opts.body));
  await recordExchange({
    method: "POST",
    url: `${baseUrl}${opts.path}`,
    headers,
    body: bodyBytes,
    expectSse: false,
  });
}

async function recordSse(opts: { path: string; body: unknown; maxEvents: number }): Promise<void> {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "text/event-stream",
    "user-agent": buildUserAgent(),
    authorization: `Bearer ${apiKey}`,
    "accept-encoding": "identity",
  });
  const bodyBytes = new TextEncoder().encode(JSON.stringify(opts.body));
  await recordExchange({
    method: "POST",
    url: `${baseUrl}${opts.path}`,
    headers,
    body: bodyBytes,
    expectSse: true,
    maxEvents: opts.maxEvents,
  });
}

async function recordRaw(opts: { method: string; path: string; body?: string }): Promise<void> {
  const headers = jsonHeaders(true);
  const bodyBytes = opts.body ? new TextEncoder().encode(opts.body) : undefined;
  await recordExchange({
    method: opts.method,
    url: `${baseUrl}${opts.path}`,
    headers,
    body: bodyBytes,
    expectSse: false,
  });
}

function jsonHeaders(auth: boolean): Headers {
  const h = new Headers({
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": buildUserAgent(),
  });
  if (auth) h.set("authorization", `Bearer ${apiKey}`);
  return h;
}

async function recordExchange(opts: {
  method: string;
  url: string;
  headers: Headers;
  body?: Uint8Array;
  expectSse: boolean;
  maxEvents?: number;
}): Promise<void> {
  const startedAt = Date.now();
  printRequest(opts);
  let response: Response;
  try {
    response = await fetch(opts.url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body as BodyInit | undefined,
    });
  } catch (err) {
    console.log("transport error:", err instanceof Error ? err.message : String(err));
    return;
  }
  console.log(`\n<<< response (${Date.now() - startedAt}ms)`);
  console.log(`status: ${response.status} ${response.statusText}`);
  response.headers.forEach((v, k) => {
    console.log(`${k}: ${v}`);
  });
  console.log();
  if (opts.expectSse && response.ok && response.body) {
    await dumpSseBody(response.body, opts.maxEvents ?? 3);
  } else {
    const text = await response.text();
    console.log(text);
  }
}

function printRequest(opts: {
  method: string;
  url: string;
  headers: Headers;
  body?: Uint8Array;
}): void {
  console.log(">>> request");
  console.log(`${opts.method} ${opts.url}`);
  opts.headers.forEach((v, k) => {
    const safe = k.toLowerCase() === "authorization" ? "Bearer <REDACTED>" : v;
    console.log(`${k}: ${safe}`);
  });
  if (opts.body) {
    console.log();
    console.log(new TextDecoder().decode(opts.body));
  }
}

async function dumpSseBody(body: ReadableStream<Uint8Array>, maxEvents: number): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let events = 0;
  const t0 = Date.now();
  try {
    while (events < maxEvents) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      while (true) {
        const idx = pending.indexOf("\n\n");
        if (idx === -1) break;
        const frame = pending.slice(0, idx);
        pending = pending.slice(idx + 2);
        events++;
        console.log(`[+${Date.now() - t0}ms] frame:`);
        console.log(frame);
        console.log();
        if (events >= maxEvents) break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // cleanup-time errors are not actionable.
    }
  }
}
