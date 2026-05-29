/**
 * Server-side limits and defaults mirrored from the Noetive Semantik
 * public API. The SDK's pre-flight validation uses these to fail fast
 * before sending a request the server would reject.
 *
 * When the server changes one of these, update both the constant here
 * and the public-api.yaml the change is sourced from.
 */

export const DEFAULT_BASE_URL = "https://semantik.noetive.io";

/**
 * Namespace the SDK falls back to when a request leaves `namespace` empty.
 * The `global` namespace is provisioned for every account with no extra
 * setup; private namespaces require dashboard configuration and incur
 * usage charges.
 */
export const DEFAULT_NAMESPACE = "global";

/**
 * Embedding model pre-configured for the `global` namespace. The SDK fills
 * this in only when the effective namespace is `global` and `model` is empty.
 */
export const DEFAULT_MODEL = "Qwen3-Embedding-4B";

/**
 * Output dimensionality of `DEFAULT_MODEL`. The SDK fills this in only when
 * the effective namespace is `global` and `dimensions` is zero.
 */
export const DEFAULT_DIMENSIONS = 1024;

/** Maximum vector dimensionality the server accepts. */
export const MAX_VECTOR_DIM = 4096;

/** Maximum text payload (UTF-8 bytes) the server accepts per item. */
export const MAX_TEXT_BYTES = 32 * 1024;

export const MAX_METADATA_KEYS = 16;
/** Maximum metadata key length in characters (Unicode code points). */
export const MAX_METADATA_KEY_LEN = 64;
/** Maximum metadata value length in characters (Unicode code points). */
export const MAX_METADATA_VALUE_LEN = 256;
export const MAX_METADATA_TOTAL_BYTES = 4 * 1024;

/** Per-endpoint request body limits. */
export const MAX_LINT_BODY_BYTES = 64 * 1024;
export const MAX_SEARCH_BODY_BYTES = 1024 * 1024;
export const MAX_SUBSCRIBE_BODY_BYTES = 1024 * 1024;
export const MAX_PUBLISH_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Fill in `model` and `dimensions` when the effective namespace is the
 * default one and the caller left them at the empty / zero value. Mutates
 * the supplied request in-place. Used by `publish`, `search`, `subscribe`.
 */
export function applyNamespaceDefaults<
  T extends { namespace?: string; model?: string; dimensions?: number },
>(req: T): T {
  if (!req.namespace || req.namespace.length === 0) {
    req.namespace = DEFAULT_NAMESPACE;
  }
  if (req.namespace !== DEFAULT_NAMESPACE) return req;
  if (!req.model) req.model = DEFAULT_MODEL;
  if (!req.dimensions || req.dimensions === 0) req.dimensions = DEFAULT_DIMENSIONS;
  return req;
}
