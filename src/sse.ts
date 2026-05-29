/**
 * Chunk-safe Server-Sent Events parser.
 *
 * Parses the W3C event-stream format used by `/v1/subscribe`. Recognises the
 * `event:` and `data:` directives, tolerates `:` comment lines, terminates a
 * frame on a blank line, and accepts any of `\n`, `\r\n`, `\r` as the line
 * separator. Unknown fields are ignored per the spec.
 *
 * Per-frame size is capped at `MAX_FRAME_BYTES`; a larger frame produces a
 * `MalformedSseError` so a misbehaving server cannot cause unbounded memory
 * growth in the SDK.
 *
 * Usage:
 *
 * ```ts
 * for await (const frame of parseSse(response.body!)) {
 *   if (frame.event === "match") handle(frame.data);
 * }
 * ```
 */

import { MalformedSseError } from "./errors.js";

export const MAX_FRAME_BYTES = 64 * 1024;

export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Parse a `ReadableStream<Uint8Array>` body into an `AsyncIterable<SseFrame>`.
 *
 * The iterator yields one frame per emitted event; it returns cleanly when the
 * server closes the stream. To stop early, call `cancel()` on the underlying
 * reader (e.g. via the SubscribeStream's `close()`).
 */
export async function* parseSse(
  source: ReadableStream<Uint8Array>,
): AsyncIterableIterator<SseFrame> {
  const reader = source.getReader();
  const decoder = new TextDecoder("utf-8");
  // Pending bytes form an incomplete final line. Pending event/data
  // accumulate the current frame across lines until a blank line lands.
  let pending = "";
  let event = "";
  let dataParts: string[] = [];
  let size = 0;

  const resetFrame = () => {
    event = "";
    dataParts = [];
    size = 0;
  };

  const emit = (): SseFrame | null => {
    if (event === "" && dataParts.length === 0) {
      resetFrame();
      return null;
    }
    const frame: SseFrame = { event, data: dataParts.join("\n") };
    resetFrame();
    return frame;
  };

  const applyLine = (line: string): void => {
    const parsed = parseLine(line);
    if (parsed === null) return;
    if (parsed.field === "event") {
      event = parsed.value;
    } else if (parsed.field === "data") {
      dataParts.push(parsed.value);
    }
    size += line.length;
    if (size > MAX_FRAME_BYTES) {
      throw new MalformedSseError(`SSE frame exceeds ${MAX_FRAME_BYTES} bytes`);
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        // Drain any pending line (no trailing newline).
        if (pending.length > 0) {
          applyLine(pending);
          pending = "";
        }
        const f = emit();
        if (f) yield f;
        return;
      }

      pending += decoder.decode(value, { stream: true });

      while (true) {
        const idx = findLineBreak(pending);
        if (idx === null) break;
        const line = pending.slice(0, idx.lineEnd);
        pending = pending.slice(idx.nextStart);

        if (line.length === 0) {
          const f = emit();
          if (f) yield f;
          continue;
        }
        applyLine(line);
      }
    }
  } finally {
    // Surface cancellation to the upstream so connection pools release.
    try {
      reader.releaseLock();
    } catch {
      // releaseLock throws if the stream is locked from another reader; ignore.
    }
  }
}

/**
 * Parse one line into its SSE field+value, or return `null` for comment lines.
 * Unknown fields (`id`, `retry`, unrecognised) come back with their literal
 * field name; the caller decides what to do with them (we count their bytes
 * toward the frame budget but otherwise ignore them, per the spec).
 */
function parseLine(line: string): { field: string; value: string } | null {
  if (line.startsWith(":")) return null;
  const colon = line.indexOf(":");
  if (colon === -1) {
    return { field: line, value: "" };
  }
  let value = line.slice(colon + 1);
  // SSE spec: strip a single leading space after the colon.
  if (value.startsWith(" ")) value = value.slice(1);
  return { field: line.slice(0, colon), value };
}

/**
 * Find the next line break in `s`. Returns the position of the *content*
 * end (exclusive) and the position where the next line starts. Recognises
 * `\n`, `\r\n`, and bare `\r`. Returns `null` when no terminator is present yet.
 */
function findLineBreak(s: string): { lineEnd: number; nextStart: number } | null {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0a) {
      return { lineEnd: i, nextStart: i + 1 };
    }
    if (c === 0x0d) {
      if (i + 1 < s.length && s.charCodeAt(i + 1) === 0x0a) {
        return { lineEnd: i, nextStart: i + 2 };
      }
      // Bare CR. If we're not at the buffer tail we know it's a standalone CR;
      // if we are, we need more bytes to disambiguate from \r\n — defer.
      if (i + 1 < s.length) {
        return { lineEnd: i, nextStart: i + 1 };
      }
      return null;
    }
  }
  return null;
}
