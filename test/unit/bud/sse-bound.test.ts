/**
 * The SSE frame cap is a memory bound: it counts UTF-8 bytes, takes a caller's
 * own bound (Bud's watch needs 4 MiB), and covers a line that never ends.
 */

import { describe, expect, it } from "vitest";
import { MalformedSseError } from "../../../src/errors.js";
import { MAX_FRAME_BYTES, parseSse } from "../../../src/sse.js";

function body(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body as ReadableStream<Uint8Array>;
}

async function drain(source: ReadableStream<Uint8Array>, max?: number): Promise<string[]> {
  const data: string[] = [];
  for await (const f of parseSse(source, max)) data.push(f.data);
  return data;
}

describe("the SSE frame bound", () => {
  it("defaults to 64 KiB", async () => {
    const big = `event: batch\ndata: ${"x".repeat(MAX_FRAME_BYTES)}\n\n`;
    await expect(drain(body(big))).rejects.toThrow(/exceeds 65536/);
  });

  it("takes a larger bound from the caller", async () => {
    const big = `event: batch\ndata: ${"x".repeat(MAX_FRAME_BYTES * 2)}\n\n`;
    const frames = await drain(body(big), MAX_FRAME_BYTES * 4);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.length).toBe(MAX_FRAME_BYTES * 2);
  });

  it("refuses a line that never ends before buffering more than one chunk past the cap", async () => {
    const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
    let pulled = 0;
    // Never a line break. Without a bound on the pending line it would be read
    // until memory ran out; it stops at 16x the cap only so a missing bound
    // shows up as the count below rather than as a hang.
    const endless = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: "));
      },
      pull(controller) {
        if (pulled >= 16 * MAX_FRAME_BYTES) {
          controller.close();
          return;
        }
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    await expect(drain(endless)).rejects.toBeInstanceOf(MalformedSseError);
    expect(pulled).toBeLessThanOrEqual(MAX_FRAME_BYTES + 2 * chunk.byteLength);
  });

  it("counts bytes, not characters", async () => {
    // 40 000 two-byte characters: under the cap counted as UTF-16 units, over it in bytes.
    const twoByte = `data: ${"é".repeat(40_000)}\n\n`;
    await expect(drain(body(twoByte))).rejects.toBeInstanceOf(MalformedSseError);

    // The same count of one-byte characters fits.
    expect(await drain(body(`data: ${"x".repeat(40_000)}\n\n`))).toHaveLength(1);

    // A surrogate pair is four bytes: 5 000 emoji are 20 006 bytes in 10 006 units.
    const emoji = `data: ${"😀".repeat(5_000)}\n\n`;
    await expect(drain(body(emoji), 16 * 1024)).rejects.toBeInstanceOf(MalformedSseError);
    expect(await drain(body(emoji), 24 * 1024)).toHaveLength(1);
  });

  it("applies the byte count to a line still waiting for its terminator", async () => {
    // No line break at all: the tail alone is over the cap in bytes.
    await expect(drain(body(`data: ${"é".repeat(40_000)}`))).rejects.toBeInstanceOf(
      MalformedSseError,
    );
  });
});

describe("parsing cost", () => {
  it("reads a 4 MiB frame arriving in small chunks in linear time", async () => {
    const encoder = new TextEncoder();
    const chunk = encoder.encode("x".repeat(4 * 1024));
    const chunks = 1024; // 4 MiB of one line
    let sent = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 0) controller.enqueue(encoder.encode("event: batch\ndata: "));
        if (sent < chunks) {
          controller.enqueue(chunk);
          sent++;
        } else {
          controller.enqueue(encoder.encode("\n\n"));
          controller.close();
        }
      },
    });
    const start = performance.now();
    const frames = await drain(source, 8 * 1024 * 1024);
    const elapsed = performance.now() - start;
    expect(frames[0]?.length).toBe(chunks * chunk.byteLength);
    // Rescanning the unfinished line on every chunk takes seconds here.
    expect(elapsed).toBeLessThan(1000);
  });
});
