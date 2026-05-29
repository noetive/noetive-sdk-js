import { describe, expect, it, vi } from "vitest";
import { Client } from "../../src/client.js";
import { InvalidRequestError } from "../../src/errors.js";
import { SemantikClient } from "../../src/semantik/client.js";

describe("Client construction", () => {
  it("rejects missing API key", () => {
    const originalKey = process.env.NOETIVE_KEY_SECRET;
    process.env.NOETIVE_KEY_SECRET = "";
    try {
      expect(() => new Client()).toThrow(InvalidRequestError);
    } finally {
      if (originalKey !== undefined) process.env.NOETIVE_KEY_SECRET = originalKey;
      else process.env.NOETIVE_KEY_SECRET = undefined;
    }
  });

  it("accepts a non-empty API key", () => {
    // The SDK validates only that the key is present; the server is the
    // authority on key format and validity.
    expect(() => new Client({ apiKey: "anything-non-empty" })).not.toThrow();
  });

  it("reads NOETIVE_KEY_SECRET from env", () => {
    const original = process.env.NOETIVE_KEY_SECRET;
    process.env.NOETIVE_KEY_SECRET = "keyu_envtest";
    try {
      const c = new Client();
      expect(c).toBeInstanceOf(Client);
    } finally {
      if (original !== undefined) process.env.NOETIVE_KEY_SECRET = original;
      else process.env.NOETIVE_KEY_SECRET = undefined;
    }
  });

  it("redacts the API key in toString()", () => {
    const c = new Client({ apiKey: "keyu_supersecret" });
    expect(String(c)).not.toContain("supersecret");
    expect(String(c)).toContain("REDACTED");
  });

  it("redacts the API key in util.inspect", () => {
    const c = new Client({ apiKey: "keyu_supersecret" });
    const inspected = (c as unknown as Record<symbol, () => string>)[
      Symbol.for("nodejs.util.inspect.custom")
    ]();
    expect(inspected).not.toContain("supersecret");
    expect(inspected).toContain("REDACTED");
  });

  it("constructs semantik lazily and caches it", () => {
    const c = new Client({ apiKey: "keyu_test" });
    const a = c.semantik;
    const b = c.semantik;
    expect(a).toBeInstanceOf(SemantikClient);
    expect(a).toBe(b);
  });
});

describe("SemantikClient — preflight via methods", () => {
  it("publish rejects empty items synchronously", async () => {
    const c = new SemantikClient({
      apiKey: "keyu_test",
      fetch: vi.fn() as unknown as typeof fetch,
    });
    await expect(c.publish({ items: [] as never })).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("search rejects empty query", async () => {
    const c = new SemantikClient({
      apiKey: "keyu_test",
      fetch: vi.fn() as unknown as typeof fetch,
    });
    await expect(c.search({ query: "" })).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("subscribe rejects empty query", async () => {
    const c = new SemantikClient({
      apiKey: "keyu_test",
      fetch: vi.fn() as unknown as typeof fetch,
    });
    await expect(c.subscribe({ query: "" })).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("lint rejects empty query", async () => {
    const c = new SemantikClient({
      apiKey: "keyu_test",
      fetch: vi.fn() as unknown as typeof fetch,
    });
    await expect(c.lint({ query: "" })).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("applies global namespace defaults on search", async () => {
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(new TextDecoder().decode(init.body));
      expect(body.namespace).toBe("global");
      expect(body.model).toBe("Qwen3-Embedding-4B");
      expect(body.dimensions).toBe(1024);
      return new Response('{"results":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const c = new SemantikClient({ apiKey: "keyu_test", fetch: fetchMock });
    await c.search({ query: "anything" });
    expect(fetchMock).toHaveBeenCalled();
  });
});
