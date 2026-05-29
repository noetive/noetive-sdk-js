/**
 * Public entry point for `@noetive/sdk`.
 *
 * Service-specific surfaces live under sub-paths (`@noetive/sdk/semantik`);
 * this root module exports the cross-service Client plus the platform-wide
 * error and retry types.
 */

export { Client, type ClientOptions } from "./client.js";
export { VERSION } from "./version.js";
export { buildUserAgent } from "./userAgent.js";

export {
  APIError,
  AuthenticationError,
  BackpressureError,
  BillingError,
  ErrorCodes,
  InvalidRequestError,
  MalformedResponseError,
  MalformedSseError,
  MethodNotAllowedError,
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
export type { ErrorCode, NoetiveErrorFields, NoetiveErrorInit } from "./errors.js";

export {
  BackoffSchedulePolicy,
  type BackoffScheduleOptions,
  DEFAULT_BACKOFF_SCHEDULE_MS,
  DEFAULT_RETRY_POLICY,
  NoRetryPolicy,
  noRetry,
  type RetryPolicy,
} from "./retry.js";
