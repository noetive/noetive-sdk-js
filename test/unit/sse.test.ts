import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MalformedSseError } from "../../src/errors.js";
import { MAX_FRAME_BYTES, parseSse } from "../../src/sse.js";

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]));
        i++;
      } else {
        controller.close();
      }
    },
  });
}

async function collect(s: ReadableStream<Uint8Array>) {
  const out: { event: string; data: string }[] = [];
  for await (const f of parseSse(s)) out.push(f);
  return out;
}

describe("parseSse — basic frames", () => {
  it("parses event + data on a single line", async () => {
    const out = await collect(makeStream(["event: match\ndata: hello\n\n"]));
    expect(out).toEqual([{ event: "match", data: "hello" }]);
  });

  it("joins multiple data: lines with \\n", async () => {
    const out = await collect(makeStream(["event: match\ndata: line1\ndata: line2\n\n"]));
    expect(out).toEqual([{ event: "match", data: "line1\nline2" }]);
  });

  it("strips one leading space after the colon (and only one)", async () => {
    const out = await collect(makeStream(["event:match\ndata:  hello\n\n"]));
    // "event" has no leading space; data drops one space, leaving " hello".
    expect(out).toEqual([{ event: "match", data: " hello" }]);
  });

  it("skips comment lines (leading colon)", async () => {
    const out = await collect(makeStream([": heartbeat\nevent: match\ndata: ok\n\n: more\n"]));
    expect(out).toEqual([{ event: "match", data: "ok" }]);
  });

  it("yields multiple frames separated by blank lines", async () => {
    const out = await collect(makeStream(["event: a\ndata: 1\n\nevent: b\ndata: 2\n\n"]));
    expect(out).toEqual([
      { event: "a", data: "1" },
      { event: "b", data: "2" },
    ]);
  });

  it("accepts \\r\\n line endings", async () => {
    const out = await collect(makeStream(["event: m\r\ndata: hi\r\n\r\n"]));
    expect(out).toEqual([{ event: "m", data: "hi" }]);
  });

  it("emits a final frame on EOF without trailing blank line", async () => {
    const out = await collect(makeStream(["event: m\ndata: tail"]));
    expect(out).toEqual([{ event: "m", data: "tail" }]);
  });
});

describe("parseSse — chunk boundary robustness", () => {
  it("handles a frame split across many chunks", async () => {
    const wire = 'event: match\ndata: {"x":1}\n\n';
    const chunks: string[] = [];
    for (let i = 0; i < wire.length; i++) chunks.push(wire[i]);
    const out = await collect(makeStream(chunks));
    expect(out).toEqual([{ event: "match", data: '{"x":1}' }]);
  });

  it("property: arbitrary splits of a known frame parse identically", async () => {
    const known = [
      { event: "subscribed", data: '{"subscription_id":"sub_1"}' },
      { event: "match", data: '{"message_id":"m1","score":0.9}' },
      { event: "match", data: '{"message_id":"m2","score":0.8}' },
    ];
    const wire = known.map((f) => `event: ${f.event}\ndata: ${f.data}\n\n`).join("");

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: wire.length }), { minLength: 1, maxLength: 20 }),
        async (raw) => {
          // Build cumulative breakpoints inside [0, wire.length].
          const sorted = Array.from(new Set([...raw, wire.length])).sort((a, b) => a - b);
          const chunks: string[] = [];
          let start = 0;
          for (const end of sorted) {
            if (end > start) {
              chunks.push(wire.slice(start, end));
              start = end;
            }
          }
          const out = await collect(makeStream(chunks));
          expect(out).toEqual(known);
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("parseSse — failure modes", () => {
  it("throws MalformedSseError when a frame exceeds MAX_FRAME_BYTES", async () => {
    const big = "x".repeat(MAX_FRAME_BYTES + 100);
    const wire = `event: match\ndata: ${big}\n\n`;
    const s = makeStream([wire]);
    await expect(collect(s)).rejects.toBeInstanceOf(MalformedSseError);
  });
});
