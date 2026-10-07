/**
 * A fake Bud server behind an injected `fetch`.
 *
 * It behaves the way the real transport does in the two respects the client
 * depends on: an aborted request signal rejects a pending fetch and errors a
 * body in flight, and cancelling a body is visible to the server as the
 * client letting go (`released`).
 */

import { expect } from "vitest";
import { BudClient, type BudClientOptions, NoRetry } from "../../../src/bud/index.js";

export interface Received {
  url: string;
  path: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
  redirect: RequestRedirect | undefined;
}

export type Handler = (
  req: Received,
  signal: AbortSignal | undefined,
) => Response | Promise<Response>;

export interface FakeFetch {
  fetch: typeof fetch;
  received: Received[];
}

/** A fetch that answers every request with `handler`, recording what arrived. */
export function fakeFetch(handler: Handler): FakeFetch {
  const received: Received[] = [];
  const impl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const req: Received = {
      url,
      path: new URL(url).pathname,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body ?? "{}")),
      redirect: init.redirect,
    };
    received.push(req);
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw signal.reason;
    return await new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(handler(req, signal)).then(
        (r) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(r);
        },
        (e) => {
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  };
  return { fetch: impl as typeof fetch, received };
}

/** A JSON answer, with the request id the server would send. */
export function answer(body: string, status = 200, requestId = "request_01answer"): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", "X-Request-Id": requestId },
  });
}

/** A client against `fetch`, with no retries unless the test asks for them. */
export function budClient(fetchImpl: typeof fetch, opts: BudClientOptions = {}): BudClient {
  return new BudClient({
    apiKey: "test-token",
    baseUrl: "https://bud.test",
    fetch: fetchImpl,
    retry: new NoRetry(),
    ...opts,
  });
}

/** The server's side of one watch, written frame by frame. */
export class ServerStream {
  private gone = false;
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
    readonly released: Promise<void>,
  ) {
    released.then(() => {
      this.gone = true;
    });
  }

  write(text: string): void {
    if (this.gone) return;
    try {
      this.controller.enqueue(this.encoder.encode(text));
    } catch {
      this.gone = true;
    }
  }

  frame(event: string, data: string): void {
    this.write(`event: ${event}\ndata: ${data}\n\n`);
  }

  open(cursor: string): void {
    this.frame("open", JSON.stringify({ cursor }));
  }

  keepalive(): void {
    this.write(": keepalive\n\n");
  }

  /** Keep the stream open until the client leaves, as the server does; the bound stops a broken test hanging the run. */
  hold(ms = 10_000): Promise<void> {
    return Promise.race([this.released, sleep(ms)]);
  }

  isGone(): boolean {
    return this.gone;
  }
}

export type Script = (s: ServerStream) => void | Promise<void>;

/** An event-stream body driven by `script`. `released` settles when the client cancels it or aborts the request. */
export function eventStream(
  script: Script,
  signal: AbortSignal | undefined,
): { body: ReadableStream<Uint8Array>; released: Promise<void> } {
  let markReleased!: () => void;
  const released = new Promise<void>((resolve) => {
    markReleased = resolve;
  });
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const s = new ServerStream(controller, released);
      signal?.addEventListener(
        "abort",
        () => {
          markReleased();
          if (!closed) {
            closed = true;
            controller.error(signal.reason);
          }
        },
        { once: true },
      );
      // After start returns, so the first frame is not enqueued before the
      // client holds the body.
      queueMicrotask(async () => {
        await script(s);
        if (!closed && !s.isGone()) {
          closed = true;
          controller.close();
        }
      });
    },
    cancel() {
      closed = true;
      markReleased();
    },
  });
  return { body, released };
}

export interface WatchServer extends FakeFetch {
  /** One per stream served, in order. */
  released: Promise<void>[];
}

/**
 * Answers /v1/watch with a 200 event stream driven by `script`, checking every
 * request has the shape the server accepts: a JSON POST asking for an event
 * stream, with the credential.
 */
export function watchServer(script: Script, opts: { delayMs?: number } = {}): WatchServer {
  const released: Promise<void>[] = [];
  const fake = fakeFetch(async (req, signal) => {
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/watch");
    expect(req.headers.get("Accept")).toBe("text/event-stream");
    expect(req.headers.get("Content-Type")).toBe("application/json");
    expect(req.headers.get("Authorization")).toBe("Bearer test-token");
    expect(req.headers.get("User-Agent")).toMatch(/^noetive-sdk-js\//);
    if (opts.delayMs) await sleep(opts.delayMs);
    const stream = eventStream(script, signal);
    released.push(stream.released);
    return new Response(stream.body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "X-Request-Id": "request_01stream" },
    });
  });
  return { ...fake, released };
}

/** Answers every request with a refusal envelope at `status`. */
export function refusingServer(status: number, body: string): FakeFetch {
  return fakeFetch(() => answer(body, status, "request_01refused"));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
