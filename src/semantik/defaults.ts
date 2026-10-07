/**
 * Server-side limits and defaults mirrored from the Noetive Semantik
 * public API. The SDK's pre-flight validation uses these to fail fast
 * before sending a request the server would reject.
 *
 * When the server changes one of these, update both the constant here
 * and the public-api.yaml the change is sourced from.
 */

/**
 * Production endpoint. Override via `SemantikClientOptions.baseUrl` or the
 * `NOETIVE_BASE_URL` environment variable.
 *
 * This base URL — together with the API key — is the SDK's entire defaulting
 * surface. The targeting fields `namespace`, `model`, and `dimensions` are
 * deliberately NOT defaulted: every publish, search, and subscribe must set
 * them explicitly. Defaulting `namespace` to a shared value would let a caller
 * who simply forgot the field route sensitive data into a namespace they never
 * intended — a data-isolation hazard — so the SDK fails preflight instead of
 * silently substituting a value.
 */
export const DEFAULT_BASE_URL = "https://semantik.noetive.io";

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
