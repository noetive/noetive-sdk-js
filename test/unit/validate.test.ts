import { describe, expect, it } from "vitest";
import { InvalidRequestError } from "../../src/errors.js";
import {
  validateApiKey,
  validateLintRequest,
  validatePublishRequest,
  validateSearchRequest,
  validateSubscribeRequest,
} from "../../src/semantik/validate.js";

describe("validateApiKey", () => {
  it("accepts any non-empty key", () => {
    // The server is the authority on key format. The SDK only enforces
    // non-emptiness so callers don't accidentally send an empty Bearer header.
    expect(() => validateApiKey("anything-non-empty")).not.toThrow();
  });
  it("rejects empty key", () => {
    expect(() => validateApiKey("")).toThrow(InvalidRequestError);
  });
});

describe("validatePublishRequest", () => {
  const base = {
    items: [{ text: "hello" }],
    namespace: "global",
    model: "Qwen3-Embedding-4B",
    dimensions: 1024,
  };

  it("accepts a fully-specified text publish", () => {
    expect(() => validatePublishRequest({ ...base })).not.toThrow();
  });

  // The SDK applies no default to namespace/model/dimensions. An unset field
  // is a fail-fast preflight error, never a silent fall-back to a shared
  // namespace — defaulting `namespace` would let a forgotten field route
  // sensitive data into a space the caller never intended.
  it("rejects missing namespace", () => {
    expect(() => validatePublishRequest({ ...base, namespace: undefined })).toThrow(
      InvalidRequestError,
    );
    expect(() => validatePublishRequest({ ...base, namespace: "" })).toThrow(InvalidRequestError);
  });

  it("rejects empty model", () => {
    expect(() => validatePublishRequest({ ...base, model: "" })).toThrow(InvalidRequestError);
    expect(() => validatePublishRequest({ ...base, model: undefined })).toThrow(
      InvalidRequestError,
    );
  });

  it("rejects 0, missing, or >4096 dimensions", () => {
    expect(() => validatePublishRequest({ ...base, dimensions: 0 })).toThrow();
    expect(() => validatePublishRequest({ ...base, dimensions: undefined })).toThrow();
    expect(() => validatePublishRequest({ ...base, dimensions: 4097 })).toThrow();
  });

  it("requires exactly one item", () => {
    expect(() => validatePublishRequest({ ...base, items: [] })).toThrow();
    expect(() =>
      validatePublishRequest({ ...base, items: [base.items[0], base.items[0]] }),
    ).toThrow();
  });

  it("requires at least one of text or vector per item", () => {
    expect(() => validatePublishRequest({ ...base, items: [{}] })).toThrow();
  });

  it("permits text+vector together (server stores vector, ignores text)", () => {
    // Per public-api.yaml: when both are supplied, `vector` takes precedence
    // and the server skips the embed call. The SDK no longer rejects this.
    expect(() =>
      validatePublishRequest({
        ...base,
        items: [{ text: "anchor text", vector: Array(1024).fill(0.1) }],
      }),
    ).not.toThrow();
  });

  it("rejects vectors with NaN or Infinity", () => {
    expect(() =>
      validatePublishRequest({
        ...base,
        items: [
          {
            vector: Array(1024)
              .fill(0)
              .map((_, i) => (i === 5 ? Number.NaN : 0.1)),
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      validatePublishRequest({
        ...base,
        items: [
          {
            vector: Array(1024)
              .fill(0)
              .map((_, i) => (i === 5 ? Number.POSITIVE_INFINITY : 0.1)),
          },
        ],
      }),
    ).toThrow();
  });

  it("requires vector length === dimensions", () => {
    expect(() =>
      validatePublishRequest({ ...base, items: [{ vector: Array(512).fill(0.1) }] }),
    ).toThrow();
  });

  it("rejects metadata with too many keys", () => {
    const md: Record<string, string> = {};
    for (let i = 0; i < 17; i++) md[`k${i}`] = "v";
    expect(() => validatePublishRequest({ ...base, metadata: md })).toThrow();
  });

  it("rejects metadata values with control chars", () => {
    expect(() => validatePublishRequest({ ...base, metadata: { key: "line1\nline2" } })).toThrow();
  });

  it("counts metadata key/value lengths as Unicode code points, not UTF-8 bytes", () => {
    // public-api.yaml's JSON Schema maxLength is characters; a 200-char
    // multi-byte value used to exceed the SDK's old byte cap but should now
    // pass alongside the server.
    const mb = "你好世界".repeat(50); // 200 code points, 600 UTF-8 bytes
    expect(() => validatePublishRequest({ ...base, metadata: { key: mb } })).not.toThrow();
  });

  it("rejects invalid ack values", () => {
    expect(() => validatePublishRequest({ ...base, ack: "ephemeral" as never })).toThrow();
  });
});

describe("validateSearchRequest", () => {
  const base = {
    query: "hello",
    namespace: "global",
    model: "Qwen3-Embedding-4B",
    dimensions: 1024,
  };

  it("accepts a fully-specified request", () => {
    expect(() => validateSearchRequest({ ...base })).not.toThrow();
  });
  it("rejects empty query", () => {
    expect(() => validateSearchRequest({ ...base, query: "" })).toThrow();
  });
  it("rejects missing namespace, model, or dimensions", () => {
    expect(() => validateSearchRequest({ ...base, namespace: undefined })).toThrow();
    expect(() => validateSearchRequest({ ...base, namespace: "" })).toThrow();
    expect(() => validateSearchRequest({ ...base, model: undefined })).toThrow();
    expect(() => validateSearchRequest({ ...base, dimensions: 0 })).toThrow();
  });
  it("rejects negative limit", () => {
    expect(() => validateSearchRequest({ ...base, limit: -1 })).toThrow();
  });
});

describe("validateSubscribeRequest", () => {
  const base = { query: "x", namespace: "global", model: "m", dimensions: 1 };

  it("accepts a fully-specified request", () => {
    expect(() => validateSubscribeRequest({ ...base })).not.toThrow();
  });
  it("rejects empty query", () => {
    expect(() => validateSubscribeRequest({ ...base, query: "" })).toThrow();
  });
  it("rejects missing namespace, model, or dimensions", () => {
    expect(() => validateSubscribeRequest({ ...base, namespace: undefined })).toThrow();
    expect(() => validateSubscribeRequest({ ...base, namespace: "" })).toThrow();
    expect(() => validateSubscribeRequest({ ...base, model: undefined })).toThrow();
    expect(() => validateSubscribeRequest({ ...base, dimensions: 0 })).toThrow();
  });
});

describe("validateLintRequest", () => {
  it("accepts a minimal request", () => {
    expect(() => validateLintRequest({ query: "x" })).not.toThrow();
  });
  it("rejects empty query", () => {
    expect(() => validateLintRequest({ query: "" })).toThrow();
  });
  it("rejects cursor out of bounds", () => {
    expect(() => validateLintRequest({ query: "abc", cursor: 100 })).toThrow();
    expect(() => validateLintRequest({ query: "abc", cursor: -1 })).toThrow();
  });
  it("treats cursor as a UTF-8 byte offset, not a UTF-16 code unit count", () => {
    // "é" is one UTF-16 code unit (length 1) but two UTF-8 bytes. The spec
    // defines `cursor` as a byte offset, so cursor=2 (end of bytes) is valid
    // and cursor=3 (past the end) is rejected.
    expect(() => validateLintRequest({ query: "é", cursor: 0 })).not.toThrow();
    expect(() => validateLintRequest({ query: "é", cursor: 1 })).not.toThrow();
    expect(() => validateLintRequest({ query: "é", cursor: 2 })).not.toThrow();
    expect(() => validateLintRequest({ query: "é", cursor: 3 })).toThrow();
    // ASCII regression: byte length and code-unit length agree, behaviour
    // unchanged.
    expect(() => validateLintRequest({ query: "abc", cursor: 3 })).not.toThrow();
    expect(() => validateLintRequest({ query: "abc", cursor: 4 })).toThrow();
  });
  it("accepts cursor at the byte boundary of a 4-byte UTF-8 character (emoji)", () => {
    // "🎯" is a single Unicode code point encoded as 4 UTF-8 bytes; in JS it
    // is a surrogate pair (length 2). Byte offsets 0..4 are valid; 5 is past
    // the end. Mid-character byte offsets (1, 2, 3) are not the SDK's concern
    // to validate — the server rejects them — but they MUST not be rejected
    // pre-flight, since the bound is purely "<= byte length".
    expect(() => validateLintRequest({ query: "🎯", cursor: 0 })).not.toThrow();
    expect(() => validateLintRequest({ query: "🎯", cursor: 1 })).not.toThrow();
    expect(() => validateLintRequest({ query: "🎯", cursor: 2 })).not.toThrow();
    expect(() => validateLintRequest({ query: "🎯", cursor: 3 })).not.toThrow();
    expect(() => validateLintRequest({ query: "🎯", cursor: 4 })).not.toThrow();
    expect(() => validateLintRequest({ query: "🎯", cursor: 5 })).toThrow();
  });
  it("handles mixed ASCII + multi-byte queries", () => {
    // "ab🎯c" = 1 + 1 + 4 + 1 = 7 UTF-8 bytes (5 UTF-16 code units).
    expect(() => validateLintRequest({ query: "ab🎯c", cursor: 7 })).not.toThrow();
    expect(() => validateLintRequest({ query: "ab🎯c", cursor: 8 })).toThrow();
    // The old UTF-16 implementation would have capped at 5 and accepted
    // cursor=5 while rejecting cursor=7. The fix flips both.
    expect(() => validateLintRequest({ query: "ab🎯c", cursor: 5 })).not.toThrow();
  });
  it("cursor === 0 always accepted for any non-empty query", () => {
    expect(() => validateLintRequest({ query: "x", cursor: 0 })).not.toThrow();
    expect(() => validateLintRequest({ query: "🎯🎯🎯", cursor: 0 })).not.toThrow();
  });
});
