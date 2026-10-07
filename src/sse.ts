/**
 * Chunk-safe Server-Sent Events parser.
 *
 * Parses the W3C event-stream format used by `/v1/subscribe`. Recognises the
 * `event:` and `data:` directives, tolerates `:` comment lines, terminates a
 * frame on a blank line, and accepts any of `\n`, `\r\n`, `\r` as the line
 * separator. Unknown fields are ignored per the spec.
 *
 * Per-frame size is capped at `MAX_FRAME_BYTES` unless the caller passes its
 * own bound (a stream whose frames batch many events, such as Bud's watch,
 * needs more); a larger frame produces a `MalformedSseError` so a misbehaving
 * server cannot cause unbounded memory growth in the SDK. The cap counts UTF-8
 * bytes, and covers a line still waiting for its terminator, so a stream that
 * never sends a line break is refused rather than buffered.
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
 *
 * `maxFrameBytes` bounds one frame; it defaults to `MAX_FRAME_BYTES`.
 */
export async function* parseSse(
  source: ReadableStream<Uint8Array>,
  maxFrameBytes: number = MAX_FRAME_BYTES,
): AsyncIterableIterator<SseFrame> {
  const reader = source.getReader();
  const decoder = new TextDecoder("utf-8");
  // `tail` holds an incomplete final line, in pieces, and `tailBytes` its
  // UTF-8 length; `afterCR` says the last chunk ended on a CR whose LF may
  // open the next. Event/data accumulate the current frame across lines
  // until a blank line lands.
  let tail: string[] = [];
  let tailBytes = 0;
  let afterCR = false;
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
    size += utf8ByteLength(line);
    if (size > maxFrameBytes) throw frameTooLarge();
  };

  const frameTooLarge = () => new MalformedSseError(`SSE frame exceeds ${maxFrameBytes} bytes`);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        // Drain any pending line (no trailing newline).
        if (tail.length > 0) {
          applyLine(tail.join(""));
          tail = [];
        }
        const f = emit();
        if (f) yield f;
        return;
      }

      // Only the new text is scanned: the unterminated tail is kept as pieces
      // with a running byte count and joined once, when its line ends, so a
      // long line arriving in small chunks costs linear time rather than a
      // rescan of everything so far on every chunk.
      const text = decoder.decode(value, { stream: true });
      let pos = 0;
      if (afterCR && text.length > 0) {
        // A CR ended the previous chunk and its line; a LF here is its pair.
        afterCR = false;
        if (text.charCodeAt(0) === 0x0a) pos = 1;
      }
      while (pos < text.length) {
        const brk = nextLineBreak(text, pos);
        if (brk === -1) {
          tail.push(text.slice(pos));
          tailBytes += utf8ByteLength(text, pos, text.length);
          break;
        }
        const line = tail.length > 0 ? tail.join("") + text.slice(pos, brk) : text.slice(pos, brk);
        tail = [];
        tailBytes = 0;
        if (text.charCodeAt(brk) === 0x0d) {
          if (brk + 1 < text.length) {
            pos = text.charCodeAt(brk + 1) === 0x0a ? brk + 2 : brk + 1;
          } else {
            afterCR = true;
            pos = brk + 1;
          }
        } else {
          pos = brk + 1;
        }

        if (line.length === 0) {
          const f = emit();
          if (f) yield f;
          continue;
        }
        applyLine(line);
      }

      // The unterminated tail belongs to the frame too. Checked here so a
      // server that never sends a line break cannot grow it past the bound:
      // memory stays within one frame plus one chunk.
      if (size + tailBytes > maxFrameBytes) throw frameTooLarge();
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
 * The UTF-8 encoded length of `s` from `from` to `to`, without encoding it. A
 * lone surrogate counts as the three bytes of the U+FFFD that replaces it.
 */
function utf8ByteLength(s: string, from = 0, to = s.length): number {
  let bytes = 0;
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < to) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
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
 * The index of the next `\n` or `\r` in `s` at or after `from`, or -1. The
 * caller treats `\r\n` as one terminator, including across chunks.
 */
function nextLineBreak(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0a || c === 0x0d) return i;
  }
  return -1;
}
