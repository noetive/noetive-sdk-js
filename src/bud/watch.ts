/**
 * Watch and wait: the journal as a stream, and one bounded window of it.
 *
 * The server serves the journal only as a stream: a named `open` frame, then
 * `batch` frames and `: keepalive` comments. `watch` hands that stream to a
 * caller that holds it for as long as it runs; `wait` opens it for one window
 * and returns the first batch, for a caller that thinks in turns.
 *
 * Setup and in-flight failure are different problems. Everything before the
 * `open` frame is setup, and a connection that failed before any response is
 * retried under the client's policy. Everything after it is in flight, and is
 * never reconnected here: the journal is stored, so a new watch from
 * `cursor()` replays everything after it. Whether and when to reconnect is the
 * caller's budget to spend.
 *
 * Delivery is at least once against the journal's per-mailbox sequence: a
 * reconnect from a cursor can repeat events, so dedupe on `JournalEvent.id`.
 */

import { MalformedSseError } from "../errors.js";
import { type SseFrame, parseSse } from "../sse.js";
import { BudError, BudErrorCodes, errorFrom, refusalFrom } from "./error.js";
import { wireBody } from "./request.js";
import { type BudTransport, type Exchange, MIME_EVENT_STREAM, readText } from "./transport.js";
import {
  type JournalEvent,
  type WaitInput,
  type WaitOutput,
  quoted,
  withoutNulls,
} from "./types.js";

/**
 * The longest window `wait` holds the stream open, and the longest quiet
 * interval the server allows before a keepalive. A caller whose own deadline
 * is shorter than its window sees its normal empty answer as an abort.
 */
export const MAX_WAIT_SECONDS = 25;

/**
 * The bound on one stream frame. A batch can carry many events, each with a
 * subject and an address a stranger chose, and escaping multiplies their size;
 * this leaves ample room and is still bounded, so a misbehaving proxy cannot
 * decide how much one stream holds.
 */
export const MAX_STREAM_FRAME_BYTES = 4 * 1024 * 1024;

/** How much of a refused handshake's body is read. */
const MAX_REFUSAL_BYTES = 1024 * 1024;

const EVENT_OPEN = "open";
const EVENT_BATCH = "batch";

/**
 * The stream ended before it answered. The server ends a stream without a batch
 * only when it is going away; reporting that as an empty window would send the
 * caller straight back to a server that is not there.
 */
export class StreamEndedError extends Error {
  constructor(message = "bud: the stream closed before answering") {
    super(message);
    this.name = "StreamEndedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** How long `wait` holds the stream: `timeout_s` clamped to [1, MAX_WAIT_SECONDS], defaulting to the maximum. */
export function waitWindowMs(seconds: number | undefined): number {
  if (seconds === undefined || !(seconds > 0) || seconds > MAX_WAIT_SECONDS) {
    return MAX_WAIT_SECONDS * 1000;
  }
  return Math.max(1, Math.trunc(seconds)) * 1000;
}

/** What one read of the stream produced. */
type Read =
  | { kind: "batch"; batch: WaitOutput }
  | { kind: "refusal"; batch: WaitOutput & { error: BudError } }
  | { kind: "end" };

/**
 * The reading side of an open stream, shared by `watch` and `wait`.
 *
 * `failure` is why the stream ended, or undefined for a clean close. `release`
 * ends it on purpose — the window closing, the caller leaving — and makes the
 * read in progress end as a failure rather than a clean close, so a frame cut
 * in half by the release is never decoded as if the server had finished it.
 */
export class JournalReader {
  cursor: string;
  failure: unknown = undefined;
  private done = false;

  constructor(
    private readonly frames: AsyncIterator<SseFrame>,
    readonly requestId: string,
    readonly release: (reason?: unknown) => void,
  ) {
    this.cursor = "";
  }

  /** Read and record the opening frame; anything else first is a setup failure. */
  async readOpen(): Promise<void> {
    const first = await this.frame();
    if (first === undefined) {
      if (this.failure !== undefined) throw this.failure;
      throw this.malformed("the stream closed before its opening frame");
    }
    if (first.event !== EVENT_OPEN) {
      throw this.malformed(
        `the stream began with a ${quoted(first.event)} frame rather than ${quoted(EVENT_OPEN)}`,
      );
    }
    const open = parseObject(first.data);
    if (typeof open === "string") {
      throw this.malformed(`the opening frame did not decode: ${open}`);
    }
    if (open.cursor !== undefined && typeof open.cursor !== "string") {
      throw this.malformed("the opening frame's cursor is not a string");
    }
    this.cursor = (open.cursor as string | undefined) ?? "";
  }

  /**
   * The next batch frame, whole. Unknown frames are skipped: refusing to read
   * the rest of a stream over a frame this version does not know would break
   * on a server that grew. A refusal ends the stream — the server does not
   * continue after one — and comes back carrying the stream's cursor, since
   * the server may send it without one.
   */
  async read(): Promise<Read> {
    while (true) {
      if (this.done) return { kind: "end" };
      const frame = await this.frame();
      if (frame === undefined) {
        this.done = true;
        return { kind: "end" };
      }
      if (frame.event !== EVENT_BATCH) continue;

      const parsed = parseObject(frame.data);
      if (typeof parsed === "string") return this.fail(`a stream frame did not decode: ${parsed}`);
      if (parsed.cursor !== undefined && typeof parsed.cursor !== "string") {
        return this.fail("a stream frame's cursor is not a string");
      }
      if (parsed.events !== undefined && parsed.events !== null && !Array.isArray(parsed.events)) {
        return this.fail("a stream frame's events are not a list");
      }
      if (parsed.cursor) this.cursor = parsed.cursor as string;

      const { error: rawError, ...rest } = parsed;
      const batch = { ...rest, cursor: this.cursor } as WaitOutput;
      if (rawError === undefined || rawError === null) return { kind: "batch", batch };

      const error = refusalFrom(rawError, 200, this.requestId);
      if (!error) return this.fail("a stream frame carried an error that is not a refusal");
      this.failure = error;
      this.done = true;
      return { kind: "refusal", batch: { ...batch, error } };
    }
  }

  private async frame(): Promise<SseFrame | undefined> {
    try {
      const next = await this.frames.next();
      return next.done ? undefined : next.value;
    } catch (cause) {
      this.failure =
        cause instanceof MalformedSseError
          ? this.malformed(`a stream frame exceeded ${MAX_STREAM_FRAME_BYTES} bytes`)
          : cause;
      this.done = true;
      return undefined;
    }
  }

  private fail(message: string): Read {
    this.failure = this.malformed(message);
    this.done = true;
    return { kind: "end" };
  }

  private malformed(message: string): BudError {
    const body = { code: BudErrorCodes.MalformedResponse, message, request_id: this.requestId };
    return new BudError(body, 200);
  }
}

/**
 * An open connection to the journal: an async iterable of events.
 *
 * Iteration ends cleanly when the server closes the stream or the stream is
 * closed, and throws on any failure: a refusal the server sent in flight (a
 * {@link BudError}), a frame this SDK could not read (`malformed_response`), a
 * dropped connection, or the caller's AbortSignal (its reason). A keepalive
 * proves the connection is alive and never surfaces. Breaking out of a loop
 * over it closes it.
 */
export class WatchStream implements AsyncIterable<JournalEvent> {
  /** Correlates this stream with the server's own records. */
  readonly requestId: string;
  private closed = false;

  /**
   * The cursor after the last event handed to the caller, which is what
   * `cursor()` reports: resuming there must not skip the rest of a batch the
   * caller stopped part-way through.
   */
  private delivered: string;

  constructor(
    private readonly reader: JournalReader,
    private readonly signal: AbortSignal | undefined,
    private readonly detach: () => void,
  ) {
    this.requestId = reader.requestId;
    this.delivered = reader.cursor;
  }

  /**
   * Where the stream has delivered to. Pass it as `WaitInput.cursor` to the
   * next watch or wait; the journal replays everything after it, including
   * what arrived while no stream was open. It moves past a batch only once
   * that batch's last event has been taken.
   */
  cursor(): string {
    return this.delivered;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<JournalEvent> {
    try {
      while (true) {
        // Everything read so far has been handed out, so the latest cursor is
        // safe to resume from. A batch that only moves the cursor commits here.
        this.delivered = this.reader.cursor;
        const read = await this.reader.read();
        if (read.kind === "batch") {
          const events = read.batch.events ?? [];
          for (let i = 0; i < events.length; i++) {
            // Committed as the last event is handed over, before the caller
            // asks for more, so stopping after it resumes past the batch.
            if (i === events.length - 1) this.delivered = read.batch.cursor;
            yield events[i] as JournalEvent;
          }
          continue;
        }
        if (this.closed) return;
        if (this.signal?.aborted) throw this.signal.reason;
        if (this.reader.failure !== undefined) throw this.reader.failure;
        return;
      }
    } finally {
      await this.close();
    }
  }

  /** Release the connection. Idempotent; iteration then ends cleanly. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    this.reader.release();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** An open stream, or the refusal the server sent instead of opening one. */
export type Opened = { reader: JournalReader } | { refusal: BudError };

/**
 * Perform the handshake: the request, the status, the content type and the
 * opening frame. A refusal before the stream opens is returned apart from the
 * failures, so `watch` can throw it and `wait` can return it as a value.
 */
export async function openJournal(
  transport: BudTransport,
  input: WaitInput,
  signal: AbortSignal | undefined,
  authorization: string | undefined,
): Promise<Opened> {
  const body = wireBody("watch", input);
  const exchange = await transport.exchange("watch", input, body, {
    signal,
    authorization,
    stream: true,
  });
  const { response, requestId } = exchange;

  try {
    if (response.status !== 200) {
      const raw = await readText(response, MAX_REFUSAL_BYTES, signal);
      exchange.end();
      const refusal = refusalOf(raw, response.status, requestId);
      if (refusal) return { refusal };
      throw errorFrom(response.status, raw, requestId);
    }

    const contentType = response.headers.get("Content-Type") ?? "";
    if (!isEventStream(contentType)) {
      throw new BudError(
        {
          code: BudErrorCodes.MalformedResponse,
          message: `the server answered 200 with content type ${contentType || "(none)"} rather than an event stream`,
          request_id: requestId || undefined,
        },
        200,
      );
    }
    if (!response.body) {
      throw new BudError(
        {
          code: BudErrorCodes.MalformedResponse,
          message: "the server answered 200 with no stream",
          request_id: requestId || undefined,
        },
        200,
      );
    }

    const body = releasable(response.body, exchange);
    const frames = parseSse(body.stream, MAX_STREAM_FRAME_BYTES);
    const reader = new JournalReader(frames, requestId, body.release);

    // Read the handshake here, so a server that never sends it is a setup
    // failure the caller can retry rather than a stream that yields nothing.
    try {
      await reader.readOpen();
    } catch (err) {
      reader.release();
      if (signal?.aborted) throw signal.reason;
      throw err;
    }
    exchange.settle();
    return { reader };
  } catch (err) {
    exchange.end();
    // The caller leaving is the answer, whatever the half-read body said.
    if (signal?.aborted) throw signal.reason;
    throw err;
  }
}

/** The refusal envelope a failed handshake carries, if that is what its body is. */
function refusalOf(raw: string, status: number, requestId: string): BudError | undefined {
  const parsed = parseObject(raw);
  if (typeof parsed === "string" || parsed.error === undefined || parsed.error === null) {
    return undefined;
  }
  return refusalFrom(parsed.error, status, requestId);
}

/**
 * Wrap a response body so this SDK can end it at any moment: `release` cancels
 * the upstream (handing the connection back) and makes the read in progress
 * fail, so a half-delivered frame is never mistaken for a finished one.
 */
function releasable(
  upstream: ReadableStream<Uint8Array>,
  exchange: Exchange,
): { stream: ReadableStream<Uint8Array>; release: (reason?: unknown) => void } {
  const source = upstream.getReader();
  let released: unknown;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await source.read();
        if (released !== undefined) controller.error(released);
        else if (done) controller.close();
        else controller.enqueue(value);
      } catch (cause) {
        controller.error(released ?? cause);
      }
    },
    cancel(reason) {
      return source.cancel(reason).catch(() => {});
    },
  });
  const release = (reason?: unknown) => {
    if (released !== undefined) return;
    released = reason ?? new Error("bud: the stream was released");
    source.cancel(released).catch(() => {});
    exchange.end();
  };
  return { stream, release };
}

/** Parse a JSON object, without its null-valued keys, or say why it is not one. */
function parseObject(data: string): Record<string, unknown> | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "not a JSON object";
  }
  return withoutNulls(parsed) as Record<string, unknown>;
}

/** The media type, with or without parameters. */
function isEventStream(contentType: string): boolean {
  const media = contentType.split(";", 1)[0] ?? "";
  return media.trim().toLowerCase() === MIME_EVENT_STREAM;
}

/**
 * Block until something happens or the window closes.
 *
 * The window starts once the stream is open, so a slow handshake does not eat
 * into it. Returns the first batch that carries events, whole, with the cursor
 * after it; batches with no events only advance the cursor. A quiet window is
 * success with the stream's latest cursor. A refusal — before the stream opens
 * (with the caller's cursor) or in flight (with the stream's) — is a value.
 * Thrown: a failed connection, an unreadable stream (`malformed_response`), a
 * stream that closed before answering ({@link StreamEndedError}), or the
 * caller's abort (its reason). Always releases its connection before returning.
 */
export async function waitOnce(
  transport: BudTransport,
  input: WaitInput,
  signal: AbortSignal | undefined,
  authorization: string | undefined,
): Promise<WaitOutput> {
  const opened = await openJournal(transport, input, signal, authorization);
  if ("refusal" in opened) {
    // The caller's own cursor, so a refusal it retries after fixing the
    // request resumes from the same place.
    return { cursor: input.cursor ?? "", error: opened.refusal };
  }
  const reader = opened.reader;

  let windowClosed = false;
  const onAbort = () => reader.release(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const window = setTimeout(() => {
    windowClosed = true;
    reader.release();
  }, waitWindowMs(input.timeout_s));

  try {
    while (true) {
      const read = await reader.read();
      if (read.kind === "batch" && (read.batch.events?.length ?? 0) === 0) continue;
      if (read.kind !== "end") return read.batch;
      if (signal?.aborted) throw signal.reason;
      if (windowClosed) return { cursor: reader.cursor };
      if (reader.failure !== undefined) throw reader.failure;
      throw new StreamEndedError();
    }
  } finally {
    clearTimeout(window);
    signal?.removeEventListener("abort", onAbort);
    reader.release();
  }
}

/**
 * Open the stream for a long-running consumer. A refusal before it opens is
 * thrown as the server's {@link BudError}; once open, the caller's AbortSignal
 * ends it.
 */
export async function watchJournal(
  transport: BudTransport,
  input: WaitInput,
  signal: AbortSignal | undefined,
  authorization: string | undefined,
): Promise<WatchStream> {
  const opened = await openJournal(transport, input, signal, authorization);
  if ("refusal" in opened) throw opened.refusal;
  const reader = opened.reader;
  const onAbort = () => reader.release(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return new WatchStream(reader, signal, () => signal?.removeEventListener("abort", onAbort));
}
