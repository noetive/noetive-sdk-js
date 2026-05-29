/**
 * SubscribeStream: AsyncIterable<MatchEvent> + close().
 *
 * The handshake reads the `subscribed` event before returning the stream so
 * the caller can rely on `subscriptionId` being populated synchronously.
 *
 * Two failure boundaries:
 *
 * - Setup failures (auth, transport, missing `subscribed` frame, oversize
 *   handshake) raise as `SubscribeSetupError` from `openSubscribeStream`.
 *   These flow through the retry policy: transient codes (503/429/transport)
 *   trigger another attempt; everything else surfaces immediately.
 * - In-flight failures (torn TCP, malformed `match` frame, oversize event)
 *   throw `SubscribeStreamError` from the iterator. NEVER retried — the
 *   subscription_id is committed server-side and reconnecting starts a
 *   fresh subscription that would miss matches delivered between the drop
 *   and the retry.
 *
 * The caller MUST call `close()` — breaking out of the `for await` loop does
 * NOT release the upstream connection on its own (the AsyncIterator's
 * `return` hook does call `close`, but only when the loop control flow
 * triggers it; the explicit call is the contract that survives both paths).
 *
 * On Node 22+ the stream also implements `Symbol.asyncDispose` so
 * `await using stream = await client.semantik.subscribe(...)` works without
 * a try/finally.
 */

import { MalformedSseError, wrapAsSubscribeSetup, wrapAsSubscribeStream } from "../errors.js";
import { parseSse } from "../sse.js";
import { MIME_SSE, type RequestOptions, type Transport } from "../transport.js";
import type { MatchEvent, SubscribeRequest, SubscribedEvent } from "./models.js";

export interface SubscribeStreamOptions {
  maxBodyBytes: number;
  requestOptions: RequestOptions;
}

export class SubscribeStream implements AsyncIterable<MatchEvent> {
  readonly subscriptionId: string;
  private readonly frames: AsyncIterableIterator<{ event: string; data: string }>;
  private readonly abort: () => void;
  private closed = false;

  constructor(
    subscriptionId: string,
    frames: AsyncIterableIterator<{ event: string; data: string }>,
    abort: () => void,
  ) {
    this.subscriptionId = subscriptionId;
    this.frames = frames;
    this.abort = abort;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<MatchEvent> {
    return this.iterate();
  }

  /**
   * Symbol.asyncDispose support for Node 22+ `await using`. Falls back
   * gracefully on older runtimes that don't recognise the symbol.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /** Idempotent. Tears down the upstream connection. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort();
    // Best-effort drain so the underlying connection returns to the pool.
    try {
      // `frames.return?.()` cancels the generator and runs its `finally` block,
      // which releases the ReadableStream reader.
      await this.frames.return?.(undefined);
    } catch {
      // Cleanup-time errors are not actionable.
    }
  }

  private async *iterate(): AsyncIterableIterator<MatchEvent> {
    try {
      while (true) {
        let next: IteratorResult<{ event: string; data: string }>;
        try {
          next = await this.frames.next();
        } catch (cause) {
          // Mid-stream failure: torn TCP, parser error, oversize frame.
          // Wrap as a stream-side error so the consumer can distinguish
          // from setup failures.
          throw wrapAsSubscribeStream(cause);
        }
        if (next.done) return;
        if (this.closed) return;
        const frame = next.value;
        if (frame.event !== "match") {
          // Forward-compatible: skip unknown event types (heartbeats, etc).
          continue;
        }
        try {
          yield parseMatchData(frame.data);
        } catch (cause) {
          throw wrapAsSubscribeStream(cause);
        }
      }
    } finally {
      await this.close();
    }
  }
}

function parseMatchData(data: string): MatchEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (cause) {
    throw new MalformedSseError(
      `match frame data is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  if (!isMatchEvent(parsed)) {
    throw new MalformedSseError("match frame missing message_id or score");
  }
  return parsed;
}

function isMatchEvent(v: unknown): v is MatchEvent {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.message_id === "string" && typeof o.score === "number";
}

function parseSubscribedData(data: string): SubscribedEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (cause) {
    throw new MalformedSseError(
      `subscribed frame data is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { subscription_id?: unknown }).subscription_id !== "string" ||
    (parsed as { subscription_id: string }).subscription_id.length === 0
  ) {
    throw new MalformedSseError("subscribed frame missing subscription_id");
  }
  return parsed as SubscribedEvent;
}

/**
 * Open the subscribe stream, retrying transient setup failures end-to-end.
 *
 * The retry boundary wraps the ENTIRE handshake: POST, content-type check,
 * body presence check, and the `subscribed` frame read. Any `NoetiveError`
 * thrown by these is offered to the retry policy; only retryable classes
 * (rate-limited / unavailable / transport) actually re-attempt. Once the
 * `subscribed` frame is consumed, the subscription_id is committed
 * server-side — errors from then on are stream-side and surface through
 * the iterator as `SubscribeStreamError`.
 *
 * On the failure path, every attempt that opened an SSE response is torn
 * down (`abort()` + `completeHandshake()`) before the throw bubbles, so a
 * retried handshake does not leak the prior socket.
 */
export async function openSubscribeStream(
  transport: Transport,
  path: string,
  body: SubscribeRequest,
  opts: SubscribeStreamOptions,
): Promise<SubscribeStream> {
  try {
    return await transport.runWithRetry(
      () => handshakeOnce(transport, path, body, opts),
      opts.requestOptions.signal,
    );
  } catch (cause) {
    // The retry loop consulted the policy on the raw NoetiveError so its
    // instanceof checks work. Wrap the *final* failure as the public
    // SubscribeSetupError type the SDK surfaces to callers.
    throw wrapAsSubscribeSetup(cause);
  }
}

/**
 * One full handshake attempt. Returns the live stream once the `subscribed`
 * frame is observed; otherwise throws the underlying typed `NoetiveError`
 * (auth, transport, malformed) un-wrapped so the surrounding `runWithRetry`
 * can classify it via the policy's `instanceof` checks. The outer caller
 * wraps the terminal failure as `SubscribeSetupError`.
 *
 * Cleanup invariant: any attempt that opens an SSE response tears it down
 * before throwing, so a retried handshake does not leak the prior socket.
 */
async function handshakeOnce(
  transport: Transport,
  path: string,
  body: SubscribeRequest,
  opts: SubscribeStreamOptions,
): Promise<SubscribeStream> {
  let abort: (() => void) | undefined;
  let completeHandshake: (() => void) | undefined;
  try {
    const sse = await transport.openSse({
      path,
      body,
      maxBodyBytes: opts.maxBodyBytes,
      options: opts.requestOptions,
    });
    abort = sse.abort;
    completeHandshake = sse.completeHandshake;
    const { response } = sse;

    // Validate Content-Type — a misconfigured proxy returning JSON / HTML with
    // 200 would otherwise feed garbage through the SSE parser.
    const contentType = response.headers.get("content-type") ?? "";
    if (!isEventStreamContentType(contentType)) {
      throw new MalformedSseError(`expected ${MIME_SSE}, got ${JSON.stringify(contentType)}`);
    }

    if (!response.body) {
      throw new MalformedSseError("subscribe response has no body");
    }

    const frames = parseSse(response.body);

    // Read the first frame inside the handshake budget.
    let first: IteratorResult<{ event: string; data: string }>;
    try {
      first = await frames.next();
    } catch (cause) {
      if (cause instanceof MalformedSseError) throw cause;
      throw new MalformedSseError(
        `failed to read subscribed frame: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
    if (first.done) {
      throw new MalformedSseError("subscribe stream closed before subscribed frame");
    }
    if (first.value.event !== "subscribed") {
      throw new MalformedSseError(
        `expected 'subscribed' event, got ${JSON.stringify(first.value.event)}`,
      );
    }
    const subscribed = parseSubscribedData(first.value.data);

    // Handshake done — disarm the budget timer so it doesn't fire during the
    // live stream, and hand the stream to the caller. From this point on,
    // failures are stream-side; the retry loop will not see them.
    completeHandshake();
    completeHandshake = undefined;
    const stream = new SubscribeStream(subscribed.subscription_id, frames, abort);
    abort = undefined; // ownership transferred to the stream
    return stream;
  } catch (cause) {
    // Tear down the prior socket so a retried attempt does not leak it.
    abort?.();
    completeHandshake?.();
    throw cause;
  }
}

/**
 * Match an RFC 9110-tolerant `Content-Type: text/event-stream` header,
 * stripping any `; charset=...` parameters a proxy might append.
 */
function isEventStreamContentType(ct: string): boolean {
  if (!ct) return false;
  const semi = ct.indexOf(";");
  const base = (semi >= 0 ? ct.slice(0, semi) : ct).trim().toLowerCase();
  return base === MIME_SSE;
}
