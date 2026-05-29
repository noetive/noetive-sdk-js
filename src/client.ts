/**
 * Root `Client` — the entry point for all Noetive services.
 *
 * Mirrors the Python SDK's `noetive.Client` → `client.semantik.*` pattern:
 * the `semantik` sub-client is created lazily on first access, so users
 * who only need one service don't pay for the others. A user who wants to
 * skip the root entirely can import `SemantikClient` directly from
 * `@noetive/sdk/semantik`.
 *
 * API keys are accepted either as a constructor argument or through the
 * `NOETIVE_KEY_SECRET` environment variable; an optional
 * `NOETIVE_BASE_URL` overrides the production endpoint (useful for
 * staging deployments and integration tests).
 *
 * The bearer token is held as part of the precomputed `Authorization`
 * header inside the transport. Inspection (`util.inspect`, `String(client)`)
 * redacts the credential so a stray log line cannot leak it.
 */

import { preflightError } from "./errors.js";
import type { RetryPolicy } from "./retry.js";
import { SemantikClient, type SemantikClientOptions } from "./semantik/client.js";
import { validateApiKey } from "./semantik/validate.js";

const ENV_API_KEY = "NOETIVE_KEY_SECRET";
const ENV_BASE_URL = "NOETIVE_BASE_URL";

export interface ClientOptions {
  /**
   * Long-lived API key from the Noetive dashboard. Falls back to
   * `process.env.NOETIVE_KEY_SECRET` when omitted.
   */
  apiKey?: string;
  /** Override the production endpoint. Falls back to `NOETIVE_BASE_URL` when set. */
  baseUrl?: string;
  retryPolicy?: RetryPolicy;
  /**
   * Inject a custom `fetch`. Defaults to the runtime's global `fetch`.
   * On Node 18+, Bun, Deno, and modern browsers, leaving this unset is
   * the expected configuration.
   */
  fetch?: typeof fetch;
  /**
   * Maximum time the SDK waits for the TCP+TLS+HTTP request to reach
   * response headers. Defaults to 10s.
   */
  connectTimeoutMs?: number;
  /**
   * Maximum time the SDK waits for a one-shot JSON response body once
   * headers are in hand. Defaults to 30s. Does not apply to the
   * long-lived subscribe stream.
   */
  readTimeoutMs?: number;
}

export class Client {
  private readonly opts: SemantikClientOptions;
  private semantikInstance: SemantikClient | undefined;

  constructor(opts: ClientOptions = {}) {
    const apiKey = opts.apiKey ?? readEnv(ENV_API_KEY);
    if (!apiKey) {
      throw preflightError(
        `API key required: pass it to new Client({ apiKey: ... }) or set ${ENV_API_KEY}`,
      );
    }
    validateApiKey(apiKey);
    const baseUrl = opts.baseUrl ?? readEnv(ENV_BASE_URL) ?? undefined;
    this.opts = {
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
      ...(opts.retryPolicy ? { retryPolicy: opts.retryPolicy } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.connectTimeoutMs !== undefined ? { connectTimeoutMs: opts.connectTimeoutMs } : {}),
      ...(opts.readTimeoutMs !== undefined ? { readTimeoutMs: opts.readTimeoutMs } : {}),
    };
  }

  /** Lazily-constructed Semantik sub-client. Cached after first access. */
  get semantik(): SemantikClient {
    if (!this.semantikInstance) {
      this.semantikInstance = new SemantikClient(this.opts);
    }
    return this.semantikInstance;
  }

  toString(): string {
    return `Client { baseUrl: ${JSON.stringify(this.opts.baseUrl ?? "<default>")}, apiKey: "REDACTED" }`;
  }

  /** Node's `util.inspect` hook — keeps the API key out of console output. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const v = proc?.env?.[name];
  return v && v.length > 0 ? v : undefined;
}
