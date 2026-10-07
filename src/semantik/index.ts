/**
 * Semantik service entry point. Import directly when only the Semantik
 * surface is needed:
 *
 * ```ts
 * import { SemantikClient } from "@noetive/sdk/semantik";
 * ```
 */

export { SemantikClient, type SemantikClientOptions } from "./client.js";
export { SubscribeStream } from "./streaming.js";

export {
  DEFAULT_BASE_URL,
  MAX_LINT_BODY_BYTES,
  MAX_METADATA_KEYS,
  MAX_METADATA_KEY_LEN,
  MAX_METADATA_TOTAL_BYTES,
  MAX_METADATA_VALUE_LEN,
  MAX_PUBLISH_BODY_BYTES,
  MAX_SEARCH_BODY_BYTES,
  MAX_SUBSCRIBE_BODY_BYTES,
  MAX_TEXT_BYTES,
  MAX_VECTOR_DIM,
} from "./defaults.js";

export type {
  AckMode,
  LintCompletion,
  LintDiagnostic,
  LintRequest,
  LintResponse,
  MatchEvent,
  PublishItem,
  PublishRequest,
  PublishResponse,
  ResultItem,
  SearchRequest,
  SearchResponse,
  SubscribeRequest,
  SubscribedEvent,
} from "./models.js";

export {
  APIError,
  AuthenticationError,
  BackpressureError,
  BillingError,
  ErrorCodes,
  InvalidRequestError,
  MalformedResponseError,
  MalformedSseError,
  MeteringUnavailableError,
  ModelNotProvisionedError,
  NamespaceDisabledError,
  NamespaceUnavailableError,
  NoetiveError,
  RateLimitError,
  RequestTooLargeError,
  ServiceUnavailableError,
  SubscribeSetupError,
  SubscribeStreamError,
  TooManyRequestsError,
  TransportError,
  UnsupportedMediaTypeError,
  wrapAsSubscribeSetup,
  wrapAsSubscribeStream,
} from "./errors.js";
export type { ErrorCode } from "./errors.js";
