/**
 * Re-export Semantik-relevant error classes from the platform module.
 *
 * The platform `errors.ts` already owns the code → class map and the
 * subclasses themselves; this module is the convenient surface for users
 * who only import from `@noetive/sdk/semantik`. No new code lives here —
 * adding aliases or wrappers would diverge from the Python SDK's
 * single-source-of-truth pattern.
 */

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
} from "../errors.js";

export type { ErrorCode, NoetiveErrorFields, NoetiveErrorInit } from "../errors.js";
