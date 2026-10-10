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
    await expect(
      c.search({ query: "", namespace: "global", model: "m", dimensions: 1 }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("subscribe rejects empty query", async () => {
    const c = new SemantikClient({
      apiKey: "keyu_test",
      fetch: vi.fn() as unknown as typeof fetch,
    });
    await expect(
      c.subscribe({ query: "", namespace: "global", model: "m", dimensions: 1 }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("lint rejects empty query", async () => {
    const c = new SemantikClient({
      apiKey: "keyu_test",
      fetch: vi.fn() as unknown as typeof fetch,
    });
    await expect(c.lint({ query: "" })).rejects.toBeInstanceOf(InvalidRequestError);
  });

  // The SDK no longer defaults the targeting tuple. A caller who forgets
  // `namespace` must be rejected before any request is sent — defaulting to a
  // shared namespace would risk routing sensitive data into a space they never
  // named. The fetch mock asserts no request leaves the SDK.
  it("publish rejects a missing namespace without sending a request", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const c = new SemantikClient({ apiKey: "keyu_test", fetch: fetchMock });
    await expect(
      c.publish({ items: [{ text: "hi" }], model: "m", dimensions: 1 } as never),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("search rejects a missing namespace without sending a request", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const c = new SemantikClient({ apiKey: "keyu_test", fetch: fetchMock });
    await expect(
      c.search({ query: "anything", model: "m", dimensions: 1 } as never),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("subscribe rejects a missing namespace without sending a request", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const c = new SemantikClient({ apiKey: "keyu_test", fetch: fetchMock });
    await expect(
      c.subscribe({ query: "anything", model: "m", dimensions: 1 } as never),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the caller's targeting tuple verbatim — no substitution", async () => {
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(new TextDecoder().decode(init.body));
      expect(body.namespace).toBe("research-papers");
      expect(body.model).toBe("Qwen3-Embedding-4B");
      expect(body.dimensions).toBe(1024);
      return new Response('{"results":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const c = new SemantikClient({ apiKey: "keyu_test", fetch: fetchMock });
    await c.search({
      query: "anything",
      namespace: "research-papers",
      model: "Qwen3-Embedding-4B",
      dimensions: 1024,
    });
    expect(fetchMock).toHaveBeenCalled();
  });

  describe("search — include_vector", () => {
    const REQ = {
      query: "anything",
      namespace: "global",
      model: "Qwen3-Embedding-4B",
      dimensions: 4,
    } as const;

    async function run(
      req: Record<string, unknown>,
      response: unknown,
    ): Promise<{
      body: Record<string, unknown>;
      res: Awaited<ReturnType<SemantikClient["search"]>>;
    }> {
      const fetchMock = vi.fn(
        async (_url: unknown, _init?: RequestInit) =>
          new Response(JSON.stringify(response), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      const c = new SemantikClient({
        apiKey: "keyu_test",
        fetch: fetchMock as unknown as typeof fetch,
      });
      const res = await c.search({ ...REQ, ...req });
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      const body = JSON.parse(new TextDecoder().decode(init.body as Uint8Array));
      return { body, res };
    }

    // Absent by default so ordinary searches keep small responses.
    it("omits include_vector from the request body when unset", async () => {
      const { body } = await run({}, { results: [] });
      expect(body).not.toHaveProperty("include_vector");
    });

    // The flag must reach the server verbatim or results never carry vectors.
    it("sends include_vector in the request body when set", async () => {
      const { body } = await run({ include_vector: true }, { results: [] });
      expect(body).toHaveProperty("include_vector", true);
    });

    // `vector` is only present when requested; absence must stay undefined.
    it("decodes result vector when present and leaves it undefined when absent", async () => {
      const { res } = await run(
        { include_vector: true },
        {
          results: [{ message_id: "a", vector: [0.1, 0.2, 0.3, 0.4] }, { message_id: "b" }],
        },
      );
      expect(res.results?.map((r) => r.vector)).toEqual([[0.1, 0.2, 0.3, 0.4], undefined]);
    });

    // A caller must be able to tell a cut-short page from a complete one.
    it("decodes truncated, undefined when the page was not cut short", async () => {
      const cut = await run({}, { results: [], truncated: true });
      const whole = await run({}, { results: [] });
      expect([cut.res.truncated, whole.res.truncated]).toEqual([true, undefined]);
    });

    // A full 50-result page of 4096-dim vectors (~2.7 MB) must decode: the
    // SDK applies no response-body cap that would reject it.
    it("decodes a 50-result page of 4096-dimension vectors", async () => {
      const vector = Array.from({ length: 4096 }, (_, i) => -0.012345679 - i * 1e-7);
      const results = Array.from({ length: 50 }, (_, i) => ({ message_id: `m${i}`, vector }));
      const { res } = await run({ dimensions: 4096, include_vector: true, limit: 50 }, { results });
      expect(res.results?.length).toBe(50);
    });
  });
});
