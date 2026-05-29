/**
 * SemantikClient — the Semantik service surface (publish / search /
 * subscribe / lint / health). Constructed lazily by the root
 * `Client.semantik` property, or directly by users who only need this
 * service.
 *
 * Subscribe lives in `./streaming.ts` so the SSE plumbing stays out of the
 * one-shot RPC path.
 */

import type { RetryPolicy } from "../retry.js";
import { type RequestOptions, Transport } from "../transport.js";
import {
  DEFAULT_BASE_URL,
  MAX_LINT_BODY_BYTES,
  MAX_PUBLISH_BODY_BYTES,
  MAX_SEARCH_BODY_BYTES,
  MAX_SUBSCRIBE_BODY_BYTES,
  applyNamespaceDefaults,
} from "./defaults.js";
import type {
  LintRequest,
  LintResponse,
  PublishRequest,
  PublishResponse,
  SearchRequest,
  SearchResponse,
  SubscribeRequest,
} from "./models.js";
import { type SubscribeStream, openSubscribeStream } from "./streaming.js";
import {
  validateApiKey,
  validateLintRequest,
  validatePublishRequest,
  validateSearchRequest,
  validateSubscribeRequest,
} from "./validate.js";

const PATH_HEALTH = "/v1/health";
const PATH_LINT = "/v1/lint";
const PATH_PUBLISH = "/v1/publish";
const PATH_SEARCH = "/v1/search";
const PATH_SUBSCRIBE = "/v1/subscribe";

export interface SemantikClientOptions {
  /** Production endpoint by default. Set to point at a staging deployment. */
  baseUrl?: string;
  apiKey: string;
  retryPolicy?: RetryPolicy;
  /**
   * Inject a custom `fetch` (e.g. for testing or to provide a polyfill on a
   * runtime that lacks a global one). Default: `globalThis.fetch`.
   */
  fetch?: typeof fetch;
  /** Connect-budget for one-shots and the subscribe handshake (default 10s). */
  connectTimeoutMs?: number;
  /** Read-budget for one-shot JSON responses (default 30s). */
  readTimeoutMs?: number;
}

export class SemantikClient {
  private readonly transport: Transport;
  private readonly baseUrlForInspect: string;

  constructor(opts: SemantikClientOptions) {
    validateApiKey(opts.apiKey);
    const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.baseUrlForInspect = baseUrl;
    this.transport = new Transport({
      baseUrl,
      apiKey: opts.apiKey,
      retryPolicy: opts.retryPolicy,
      fetch: opts.fetch,
      connectTimeoutMs: opts.connectTimeoutMs,
      readTimeoutMs: opts.readTimeoutMs,
    });
  }

  toString(): string {
    return `SemantikClient { baseUrl: ${JSON.stringify(this.baseUrlForInspect)}, apiKey: "REDACTED" }`;
  }

  /** Node's `util.inspect` hook — keeps the API key out of console output. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }

  /**
   * Liveness probe. Returns when the server replies 200. Unauthenticated per
   * the public API — the SDK omits the `Authorization` header on this call.
   */
  async health(options: RequestOptions = {}): Promise<void> {
    await this.transport.doJsonNoResponse({
      path: PATH_HEALTH,
      body: {},
      auth: "none",
      maxBodyBytes: MAX_LINT_BODY_BYTES,
      options,
    });
  }

  /**
   * Validate a SemQL query and return diagnostics plus auto-complete
   * suggestions. Unauthenticated per the public API.
   */
  async lint(req: LintRequest, options: RequestOptions = {}): Promise<LintResponse> {
    validateLintRequest(req);
    return this.transport.doJson<LintRequest, LintResponse>({
      path: PATH_LINT,
      body: req,
      auth: "none",
      maxBodyBytes: MAX_LINT_BODY_BYTES,
      options,
    });
  }

  /**
   * Ingest a single message into the namespace.
   *
   * Pair with `idempotency_key` if the caller is using the default retry
   * policy — retrying a publish without a key risks duplicate delivery.
   */
  async publish(req: PublishRequest, options: RequestOptions = {}): Promise<PublishResponse> {
    const withDefaults = applyNamespaceDefaults({ ...req });
    validatePublishRequest(withDefaults);
    return this.transport.doJson<PublishRequest, PublishResponse>({
      path: PATH_PUBLISH,
      body: withDefaults,
      auth: "bearer",
      maxBodyBytes: MAX_PUBLISH_BODY_BYTES,
      options,
    });
  }

  /** Run a SemQL query and return the ranked matches. */
  async search(req: SearchRequest, options: RequestOptions = {}): Promise<SearchResponse> {
    const withDefaults = applyNamespaceDefaults({ ...req });
    validateSearchRequest(withDefaults);
    return this.transport.doJson<SearchRequest, SearchResponse>({
      path: PATH_SEARCH,
      body: withDefaults,
      auth: "bearer",
      maxBodyBytes: MAX_SEARCH_BODY_BYTES,
      options,
    });
  }

  /**
   * Open a persistent SSE subscription. The returned `SubscribeStream` is
   * an AsyncIterable of `MatchEvent`s; the caller MUST call `close()` (or
   * use `await using` on Node 22+) to release the upstream connection.
   *
   * Setup failures (auth, transport, missing `subscribed` frame) reject the
   * returned promise as a typed `NoetiveError`. In-flight failures
   * propagate to the consumer through the iterator throwing.
   */
  async subscribe(req: SubscribeRequest, options: RequestOptions = {}): Promise<SubscribeStream> {
    const withDefaults = applyNamespaceDefaults({ ...req });
    validateSubscribeRequest(withDefaults);
    return openSubscribeStream(this.transport, PATH_SUBSCRIBE, withDefaults, {
      maxBodyBytes: MAX_SUBSCRIBE_BODY_BYTES,
      requestOptions: options,
    });
  }
}
