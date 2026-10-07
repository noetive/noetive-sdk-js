/**
 * Bud's wire types, field for field with the contract the server declares.
 *
 * Field names are the wire's snake_case names, as in the Semantik models: these
 * objects go through `JSON.stringify` / `JSON.parse` unchanged. The encoding is
 * checked rather than hoped for: the server's own description of its shapes is
 * vendored under `test/fixtures/bud/contract.golden`, and a unit test fails
 * when a fully-populated value of any contract type encodes different names.
 *
 * Request types mark a field optional when a caller may leave it out; the
 * client still puts the wire's always-present fields (`WaitInput.mailbox`,
 * `SendInput.to`) on the wire, because the server's document always carries
 * them. Timestamps stay RFC 3339 strings, as they arrive.
 */

import { BudError, BudErrorCodes, preflight } from "./error.js";
import { Kind } from "./vocab.js";

/** The contract generation this SDK implements; compared against the vendored description. */
export const CONTRACT_VERSION = "bud/v1";

// --- The contract types ----------------------------------------------------

/** Asks for whatever a reference names. */
export interface ReadInput {
  ref: string;
  max_chars?: number;
  cursor?: string;
}

/**
 * What a read returns. `text` and `content` carry the same object two ways:
 * the rendering a model reads and the structure a program branches on. Gate on
 * `provenance`, not on parsed text — that is why the two travel together.
 */
export interface ReadOutput {
  ref?: string;
  kind?: string;
  /** For a message or a thread, begins with a banner naming what follows as data; see `hasBanner`. */
  text?: string;
  /** The structure; read it through {@link into}. */
  content?: unknown;
  provenance?: Provenance;
  /** Continues a truncated answer, when there is a way to continue it. */
  cursor?: string;
  /** There is more than this answer carries. */
  truncated?: boolean;
  /** Declared by the wire and not sent. */
  version?: string;
  error?: BudError;
}

/**
 * How far a message's claims about itself can be trusted — separate from the
 * content, so a caller can refuse to act on an unauthenticated message without
 * reading a word of it.
 */
export interface Provenance {
  spf?: string;
  dkim?: string;
  dmarc?: string;
  /** The one to branch on: the authenticated domain and the visible From agree. */
  aligned: boolean;
  in_tenant: boolean;
  known: boolean;
  /** How the message joined its conversation; see `ThreadJoin`. */
  thread_join?: string;
  /** Declared by the wire and not sent. */
  folder?: string;
  /** Declared by the wire and not sent. */
  removed?: Record<string, number>;
}

/** Writes to whatever a reference names. */
export interface PutInput {
  ref: string;
  body: unknown;
  /** Declared by the wire; no write takes one, and one sent is refused as invalid. */
  version?: string;
  idempotency_key?: string;
}

/** What a write returns. */
export interface PutOutput {
  ref?: string;
  /** Declared by the wire and not sent. */
  version?: string;
  created?: boolean;
  /** What the write changed; see `EffectKind`. */
  effects?: Effect[];
  error?: BudError;
}

/** One consequence of a write. */
export interface Effect {
  kind: string;
  count?: number;
  ref?: string;
}

/** Composes and sends a message. */
export interface SendInput {
  /** May be empty when `cc` or `bcc` names someone, or on a reply. A send with no recipients at all is refused. */
  to?: string[];
  subject?: string;
  text?: string;
  html?: string;
  cc?: string[];
  bcc?: string[];
  from?: string;
  /** Needs a grant, and this server refuses it: nothing here can confirm a person decided that message. */
  on_behalf_of?: string;
  in_reply_to?: string;
  reply_all?: boolean;
  /** Declared by the wire; a send that sets it is refused as invalid. */
  attach?: string[];
  /**
   * The machine-readable part, for an exchange between two agents: an object
   * with bud, intent, corr, in_reply_to_corr, schema, hops and payload. Send
   * hops as the count on the message being answered; the server adds one.
   */
  agent?: unknown;
  /**
   * Makes a retried send return the first one's result for seven days instead
   * of sending again. Never reuse one for a different message: it returns the
   * first result and sends nothing. This SDK never retries a send without one.
   */
  idempotency_key?: string;
}

/**
 * What a send returns. A new send is `queued`; a repeat with the same
 * idempotency key reports the message's state now.
 */
export interface SendOutput {
  message?: string;
  thread?: string;
  state?: string;
  /** Why a queued message waits ("provisioning", "paused"), or why a repeated one failed. */
  reason?: string;
  /** What is left of each sending limit after this message. */
  remaining?: Record<string, number>;
  error?: BudError;
}

/** What `watch` and `wait` follow, and from where. */
export interface WaitInput {
  /** Where to resume. Empty starts at the tail. */
  cursor?: string;
  /** One mailbox; empty means every mailbox the key can read. Always on the wire, as "" when unset. */
  mailbox?: string;
  /**
   * How long a quiet interval lasts before a keepalive, and for `wait` how long
   * the window is. At most `MAX_WAIT_SECONDS`; unset takes it.
   */
  timeout_s?: number;
  /** Narrows to these event types (`EventType`). An unknown type is refused before the stream opens. */
  types?: string[];
  /** Narrows to messages with (true) or without (false) a machine-readable part. Unset matches both. */
  agent_part?: boolean;
}

/**
 * What `wait` returns, and what each batch on a stream carries. No events and
 * no error is success — nothing happened within the window. `cursor` is where
 * to resume, including after a refusal.
 */
export interface WaitOutput {
  events?: JournalEvent[];
  cursor: string;
  error?: BudError;
}

/** One thing that happened. Delivery is at least once: dedupe on `id`. */
export interface JournalEvent {
  id: string;
  tenant: string;
  /** RFC 3339. */
  ts: string;
  /** Orders events within a mailbox. A uint64 on the wire; compare, do not do arithmetic. */
  seq: number;
  type: string;
  mailbox: string;
  message: string;
  thread: string;
  actor: Actor;
  /** Ties this event to the request that caused it: the same token the response carried as X-Request-Id. */
  corr?: string;
  data: EventData;
}

/** Who caused an event. */
export interface Actor {
  /** See `ActorKind`. */
  kind: string;
  /** The agent that acted, when `kind` is agent. */
  agent: string;
}

/**
 * The little an event carries about itself: enough to triage on, and no more,
 * because every field here is also one somebody else chose.
 */
export interface EventData {
  from?: string;
  subject?: string;
  aligned?: boolean;
  in_tenant?: boolean;
  known?: boolean;
  agent_part?: boolean;
  folder?: string;
  guard?: string;
  counter?: string;
  reason?: string;
  state?: string;
  /** An opaque delivery reference for a message that was handed on. */
  provider?: string;
  /** The RFC 5322 Message-ID recipients see, without angle brackets. Set on mail.sent. */
  message_id?: string;
}

/** Who the caller is and what it can reach — where every other identifier comes from. */
export interface Me {
  agent: string;
  tenant: string;
  kind?: string;
  name?: string;
  /** What this agent sends as. The first is the default. */
  addresses?: string[];
  mailbox?: string;
  /** Every mailbox this caller may read. */
  readable_mailboxes?: string[];
  scopes?: string[];
  granted?: string[];
  /** What is left of each sending budget. */
  limits?: Record<string, number>;
  /** Whether mail sent from these addresses goes out now. */
  sending?: SendingStatus;
}

/** A folder's contents. */
export interface Listing {
  mailbox: string;
  folder: string;
  messages?: Summary[];
}

/** A thread's messages in order. */
export interface Conversation {
  thread: string;
  messages?: Summary[];
}

/** One message, as much as a listing shows: enough to triage without opening it. */
export interface Summary {
  message: string;
  thread?: string;
  subject?: string;
  /** RFC 3339. */
  date: string;
  from?: string;
  from_name?: string;
  aligned: boolean;
  in_tenant: boolean;
  known: boolean;
  join?: string;
  attachments?: number;
  unread?: boolean;
  /** The stored message is missing parts; what is here is true, and not all of it. */
  incomplete?: boolean;
}

// --- Views and probes: not in the contract ----------------------------------
//
// The views `content` holds for the kinds that have one, and the probes. They
// follow the published API description field for field; read the views through
// `into`.

/**
 * Whether mail an agent sends now goes out now (`SendingState`). Worth reading
 * before composing: a new agent's domain takes minutes to verify, and a send in
 * that window is queued, not delivered.
 */
export interface SendingStatus {
  status: string;
  reason?: string;
}

/** A mailbox's own state. Content for kind `mailbox`. */
export interface MailboxView {
  mailbox: string;
  /** An operator stopped this mailbox sending; `reason` says why. */
  paused?: boolean;
  reason?: string;
  /** How many messages are in each folder. */
  folders?: Record<string, number>;
  correspondents?: number;
  limits?: Record<string, number>;
  /** A count hit its bound; the real number is at least what is reported. */
  approximate?: boolean;
  sending?: SendingStatus;
}

/** Who a mailbox has exchanged mail with. Content for kind `corr`. */
export interface Correspondents {
  mailbox: string;
  correspondents?: CorrespondentView[];
}

/** One address and the traffic with it: facts about traffic, not a curated contact. */
export interface CorrespondentView {
  addr: string;
  /** RFC 3339. */
  first_seen: string;
  /** RFC 3339. */
  last_seen: string;
  inbound?: number;
  outbound?: number;
  /** The last verdict rather than a summary: a long-trusted address failing now is the shape of a takeover. */
  last_auth?: string;
  last_aligned?: boolean;
}

/**
 * One part of a message in the mode that was asked for. Content for kind
 * `part`. `type` and `filename` are the sender's claims, not facts.
 */
export interface PartView {
  message: string;
  part: string;
  mode: string;
  type?: string;
  filename?: string;
  size?: number;
  /**
   * The part's content, for `PartMode.Bytes`. The wire carries it as
   * `bytes_base64`; `into` decodes it so the caller never handles the encoding.
   */
  bytes?: Uint8Array;
}

/** A message's structure: content of a `Render.Parts` read. Each part's `n` is what `describePart` takes. */
export interface PartMap {
  message: string;
  parts?: PartInfo[];
}

/** One part of a message, as a parts reading lists it. Type, charset, filename and disposition are claims. */
export interface PartInfo {
  n: string;
  type: string;
  charset?: string;
  filename?: string;
  disposition?: string;
  size: number;
  children?: PartInfo[];
}

/** What the health probe returns: whether this credential is accepted, and as which agent. */
export interface Health {
  contract?: string;
  agent?: string;
  tenant?: string;
  /** A key reaching no agent here is forbidden_scope; only unauthorized means the key itself does not work. */
  error?: BudError;
}

/** The operations this deployment serves and the reference shapes beneath them. */
export interface Catalog {
  contract?: string;
  operations?: CatalogOperation[];
  kinds?: CatalogKind[];
  error?: BudError;
}

/** One operation, as a client discovers it. */
export interface CatalogOperation {
  name: string;
  path: string;
  kind?: string;
  served: boolean;
  doc?: string;
  body?: string;
}

/** One reference shape. */
export interface CatalogKind {
  kind: string;
  pattern: string;
  doc?: string;
  readable: boolean;
  writable: boolean;
  served: boolean;
  verb?: string;
  action?: string;
  params?: string[];
}

// --- Reading the outputs ---------------------------------------------------

/** Whether this deployment implements an operation, named as the catalog names it ("ListFolder") or by its path ("folder.list"). */
export function served(catalog: Catalog, name: string): boolean {
  return catalog.operations?.find((op) => op.name === name || op.path === name)?.served ?? false;
}

/**
 * Whether a wait's window closed with nothing in it. Not a failure and nothing
 * to retry: wait again from the returned cursor. Treating it as an error —
 * backing off, alerting, discarding the cursor — is the mistake this exists to
 * prevent.
 */
export function isEmptyWait(out: WaitOutput): boolean {
  return out.error === undefined && (out.events?.length ?? 0) === 0;
}

/** The view each kind's content decodes into. `message` is the `PartMap` of a `Render.Parts` read. */
export interface ViewByKind {
  me: Me;
  mailbox: MailboxView;
  folder: Listing;
  corr: Correspondents;
  thread: Conversation;
  part: PartView;
  message: PartMap;
}

/**
 * Decode a read's content into the view for its kind.
 *
 * A refusal is thrown as itself. A view of the wrong kind is refused (an
 * `invalid` BudError with httpStatus 0) rather than decoded into fields that
 * would read as an empty mailbox; so is an answer with no content, such as
 * help, whose text is the whole of it. Without a kind, the content is returned
 * unchecked for a caller's own shape. Everything here was written by somebody
 * else, so content that is not a JSON object, or a part whose bytes are not
 * base64, is `malformed_response`.
 */
export function into<K extends keyof ViewByKind>(out: ReadOutput, kind: K): ViewByKind[K];
export function into(out: ReadOutput): unknown;
export function into(out: ReadOutput, kind?: keyof ViewByKind): unknown {
  if (out.error) throw out.error;
  if (kind !== undefined && out.kind !== kind) {
    throw preflight(
      BudErrorCodes.Invalid,
      `a ${quoted(out.kind)} answer does not decode into a ${quoted(kind)} view`,
    );
  }
  if (out.content === undefined || out.content === null) {
    throw preflight(
      BudErrorCodes.Invalid,
      `this ${quoted(out.kind)} answer carries no content; read its text`,
    );
  }
  if (kind === undefined) return out.content;
  if (typeof out.content !== "object" || Array.isArray(out.content)) {
    throw malformed(`the ${quoted(kind)} content is not an object`);
  }
  const content = withoutNulls(out.content) as Record<string, unknown>;
  if (kind !== Kind.Part) return content;

  const { bytes_base64, ...rest } = content;
  const view = rest as unknown as PartView;
  if (bytes_base64 !== undefined && bytes_base64 !== null) {
    if (typeof bytes_base64 !== "string") throw malformed("bytes_base64 is not a string");
    view.bytes = decodeBase64(bytes_base64);
  }
  return view;
}

function decodeBase64(s: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(s);
  } catch {
    throw malformed("bytes_base64 is not standard base64");
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function malformed(message: string): BudError {
  return new BudError({ code: BudErrorCodes.MalformedResponse, message });
}

/** A name for a message, without letting an empty one read as a missing word. */
export function quoted(s: string | undefined): string {
  return s ? JSON.stringify(s) : "(unnamed)";
}

/** Fields whose value is opaque JSON, kept exactly as the server sent it. */
const OPAQUE = new Set(["content", "current", "agent", "body"]);

/**
 * The decoded value with every null-valued key left out, recursively, so a
 * server `null` reads as the absent field the types promise rather than a
 * value of a type they do not name. Opaque fields are the caller's to read and
 * are kept as sent.
 */
export function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === null) continue;
    out[key] = OPAQUE.has(key) ? v : withoutNulls(v);
  }
  return out;
}
