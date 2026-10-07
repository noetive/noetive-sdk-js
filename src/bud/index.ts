/**
 * Noetive Bud: managed mail for agents — read a mailbox, wait for what happens
 * in it, and send.
 *
 * ```ts
 * import { BudClient, Kind, into } from "@noetive/sdk/bud";
 *
 * const bud = BudClient.fromEnv(); // or new BudClient({ apiKey: "keya_..." })
 * const out = await bud.listFolder({ in: "ag_...", unread: true });
 * if (out.error) {
 *   // a refusal: branch on out.error.code; out.error.hint says what would unblock it
 * } else {
 *   const inbox = into(out, Kind.Folder);
 * }
 * ```
 *
 * Refusals are values: an operation resolves with its own output and `error`
 * set. A thrown error means the request never got an answer — a failed
 * connection, an unreadable response, the caller's abort, or a request refused
 * before sending (a BudError with httpStatus 0). `watch` is the one exception:
 * a stream has no envelope, so its refusals are thrown.
 *
 * Mail carries text somebody else chose. A message's rendered text begins with
 * a banner marking what follows as data (`hasBanner`), and `provenance` says
 * whether the sender could be verified — check `provenance.aligned` before
 * acting on what a message asks.
 *
 * Events: `wait` blocks for one window and returns the first batch (or an
 * empty success); pass its cursor to the next wait. `watch` holds one stream
 * for a long-running consumer. Delivery is at least once: dedupe on the
 * event's `id`. Pass an idempotency key on every send: a repeat with the same
 * key returns the first send's result, and this SDK never retries a send
 * without one.
 */

export {
  BudClient,
  type BudClientOptions,
  type ByID,
  type CallOptions,
  type Change,
  DEFAULT_BASE_URL,
  ENV_BASE_URL,
  ENV_KEY,
  type In,
  MAX_RESPONSE_BYTES,
  type MessageChanges,
} from "./client.js";
export { BudError, type BudErrorBody, type BudErrorCode, BudErrorCodes } from "./error.js";
export {
  DEFAULT_BACKOFF_MS,
  NoRetry,
  type RetryPolicy,
  TransientRetry,
  type TransientRetryOptions,
} from "./retry.js";
export { DEFAULT_RESPONSE_TIMEOUT_MS } from "./transport.js";
export {
  type Actor,
  CONTRACT_VERSION,
  type Catalog,
  type CatalogKind,
  type CatalogOperation,
  type Conversation,
  type CorrespondentView,
  type Correspondents,
  type Effect,
  type EventData,
  type Health,
  type JournalEvent,
  type Listing,
  type MailboxView,
  type Me,
  type PartInfo,
  type PartMap,
  type PartView,
  type Provenance,
  type PutInput,
  type PutOutput,
  type ReadInput,
  type ReadOutput,
  type SendInput,
  type SendOutput,
  type SendingStatus,
  type Summary,
  type ViewByKind,
  type WaitInput,
  type WaitOutput,
  into,
  isEmptyWait,
  served,
} from "./types.js";
export {
  ActorKind,
  BANNER_PREFIX,
  EffectKind,
  EventType,
  Folder,
  Kind,
  PartMode,
  Prefix,
  Render,
  SendState,
  SendingState,
  ThreadJoin,
  carriesSenderContent,
  hasBanner,
} from "./vocab.js";
export {
  MAX_STREAM_FRAME_BYTES,
  MAX_WAIT_SECONDS,
  StreamEndedError,
  WatchStream,
} from "./watch.js";
