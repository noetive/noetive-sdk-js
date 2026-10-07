/**
 * The Bud client, and the one decision in it worth arguing about.
 *
 * A refusal is a value, not a thrown error. Bud answers a rejected request
 * with the operation's own output: a populated `error` inside a well-formed
 * envelope. That comes back resolved, because the envelope is what the caller
 * acts on — the code to branch on, the hint that says what would unblock it,
 * the limit that fired and when it clears.
 *
 * ```ts
 * const out = await bud.describeMessage({ id });   // throws: the request never got an answer
 * if (out.error) { ... out.error.code ... }         // a refusal
 * else { ... out.text, into(out, Kind.Message) ... }
 * ```
 *
 * A thrown error means the request never got an answer: a failed connection
 * (thrown as `fetch` threw it), a response this SDK could not read (a
 * `malformed_response` BudError), the caller's abort (the signal's reason), or
 * a request refused before sending (a BudError with httpStatus 0).
 *
 * This differs from the Semantik client, which throws on any non-2xx. That
 * service's envelope is four flat fields; Bud's carries what a caller needs to
 * recover, and flattening it into a throw would delete it. `watch` is the one
 * exception: a stream has no envelope, so its refusals are thrown.
 */

import { type BudError, BudErrorCodes, errorFrom, preflight, refusalFrom } from "./error.js";
import { wireBody } from "./request.js";
import { type RetryPolicy, TransientRetry } from "./retry.js";
import { BudTransport, DEFAULT_RESPONSE_TIMEOUT_MS, readText } from "./transport.js";
import {
  type Catalog,
  type Health,
  type PutOutput,
  type ReadOutput,
  type SendInput,
  type SendOutput,
  type WaitInput,
  type WaitOutput,
  withoutNulls,
} from "./types.js";
import { Prefix } from "./vocab.js";
import { type WatchStream, waitOnce, watchJournal } from "./watch.js";

/**
 * The endpoint a client uses unless told otherwise: the geo-routed apex name,
 * because a base URL compiled into other people's programs cannot move.
 */
export const DEFAULT_BASE_URL = "https://bud.noetive.io";

/**
 * The agent's Noetive key. Bud mints no credential of its own; one key reaches
 * every Noetive product, so this is the variable every Noetive SDK reads.
 */
export const ENV_KEY = "NOETIVE_KEY_SECRET";

/** Points the client somewhere other than production. Each product has its own endpoint, so its own variable. */
export const ENV_BASE_URL = "NOETIVE_BUD_BASE_URL";

/** Bounds a reply: generous because a rendered thread is legitimately large, bounded so a proxy cannot decide how much this process allocates. */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface BudClientOptions {
  /** Defaults to {@link DEFAULT_BASE_URL}. */
  baseUrl?: string;
  /** Replaces the transport, e.g. in tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Defaults to one retry of a connection that failed; {@link NoRetry} opts out. */
  retry?: RetryPolicy;
  /**
   * How long to wait for a response to begin, in milliseconds; 0 disables.
   * Never bounds a body, so it never cuts a wait's window or a watch.
   */
  responseTimeoutMs?: number;
}

/** Options for one call. */
export interface CallOptions {
  /** Ends the call; the call then rejects with the signal's reason. For `watch`, ends the stream. */
  signal?: AbortSignal;
  /**
   * The Authorization header for this call, on a forwarding client only. Left
   * out, the call goes without one and Bud answers its own `unauthorized`
   * refusal — the one to relay.
   */
  authorization?: string;
}

/** Names one object by its self-describing identifier. Each describe operation reads only its own fields; another's is refused as invalid. */
export interface ByID {
  id: string;
  /** Bounds `describeMessage`'s rendering: at most, and by default, 20000. Ignored with `Render.Raw`. */
  max_chars?: number;
  /** How `describeMessage` renders: `Render.Text`, `Render.Raw` or `Render.Parts`. */
  render?: string;
  /** Continues a truncated rendering. */
  cursor?: string;
  /** One part of a message, by the number a `Render.Parts` reading lists. Only `describePart` reads it. */
  part?: string;
  /** How `describePart` returns the part: `PartMode.Text` or `PartMode.Bytes`. */
  mode?: string;
  /** How many of a thread's most recent messages `describeThread` renders: 20 by default, at most 50. */
  max_messages?: number;
}

/** Names a collection by the identifier of whatever holds it, with its filters. */
export interface In {
  /** The mailbox, by its agent's identifier. */
  in: string;
  /** `Folder.Inbox` (the default), `Folder.Sent` or `Folder.Quarantine`. */
  folder?: string;
  /** Only unread messages. */
  unread?: boolean;
  /** Only messages carrying a machine-readable part. */
  agent?: boolean;
  /** RFC 3339, inclusive. Anything else is refused rather than read as a different window. */
  since?: string;
  /** RFC 3339. */
  before?: string;
  from?: string;
  thread?: string;
  /** Narrows correspondents to addresses containing it, ignoring case. */
  q?: string;
  /**
   * How many entries to examine for this page, not how many match: 50 by
   * default, at most 200. With a filter a page can come back short or empty
   * and still carry a cursor; keep paging until there is none.
   */
  limit?: number;
  /** Resumes a listing; pass back unchanged the one the previous page returned. */
  cursor?: string;
}

/** What `updateMessage` changes; at least one. */
export interface MessageChanges {
  read?: boolean;
  /** Replaces the message's labels whole, so an empty list removes them all. */
  labels?: string[];
}

/**
 * Writes to an existing message. Not compare-and-swap: the last write wins,
 * and a body carrying a version is refused as invalid.
 */
export interface Change {
  id: string;
  changes: MessageChanges;
  /** Remembered best-effort for up to an hour; reusing one for a different change is refused as invalid. */
  idempotency_key?: string;
}

type Credential = { kind: "key"; header: string } | { kind: "forwarding" };

/**
 * Talks to one Bud deployment. Immutable and safe to share; it holds a base
 * URL, a transport and at most one credential, and never prints the
 * credential.
 */
export class BudClient {
  // ECMAScript private fields, so no enumeration, JSON.stringify or
  // structured clone of the client can reach the credential.
  readonly #transport: BudTransport;
  readonly #credential: Credential;
  readonly #baseUrl: string;

  /** A client that carries one Noetive key (keya_...). */
  constructor(opts: BudClientOptions & { apiKey: string });
  constructor(opts: BudClientOptions & { forwarding: true });
  constructor(opts: BudClientOptions & ({ apiKey: string } | { forwarding: true })) {
    if ("forwarding" in opts && opts.forwarding === true) {
      this.#credential = { kind: "forwarding" };
    } else {
      const key = (opts as { apiKey?: unknown }).apiKey;
      if (typeof key !== "string" || key.trim() === "") {
        throw preflight(
          BudErrorCodes.Invalid,
          "a key is required; pass one or use BudClient.forwarding()",
        );
      }
      this.#credential = { kind: "key", header: `Bearer ${key}` };
    }
    this.#baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#transport = new BudTransport({
      baseUrl: this.#baseUrl,
      fetch: opts.fetch ?? defaultFetch(),
      retry: opts.retry ?? new TransientRetry(),
      responseTimeoutMs: opts.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS,
    });
  }

  /**
   * A client that holds no credential and takes one per call, for a relay.
   * It does not validate, parse or cache what it is given; the header belongs
   * to the request being relayed and must not outlive it.
   */
  static forwarding(opts: BudClientOptions = {}): BudClient {
    return new BudClient({ ...opts, forwarding: true });
  }

  /**
   * A client from `NOETIVE_KEY_SECRET` (required) and `NOETIVE_BUD_BASE_URL`
   * (optional). An explicit `baseUrl` still wins: an argument is a decision,
   * the environment a fallback. A literal `${...}` placeholder is refused —
   * an editor launched from a desktop icon often never reads a shell profile,
   * and sending it would come back `unauthorized` about an account that is fine.
   */
  static fromEnv(opts: BudClientOptions = {}): BudClient {
    const key = readEnv(ENV_KEY);
    if (key === "") throw preflight(BudErrorCodes.Invalid, `${ENV_KEY} is not set`);
    if (key.startsWith("${") && key.endsWith("}")) {
      throw preflight(
        BudErrorCodes.Invalid,
        `${ENV_KEY} contains an unexpanded \${...} placeholder rather than a token`,
      );
    }
    const baseUrl = opts.baseUrl ?? (readEnv(ENV_BASE_URL) || undefined);
    return new BudClient({ ...opts, ...(baseUrl ? { baseUrl } : {}), apiKey: key });
  }

  toString(): string {
    return `BudClient { baseUrl: ${JSON.stringify(this.#baseUrl)}, credential: "[redacted]" }`;
  }

  /** What `JSON.stringify` writes: the endpoint, never the credential. */
  toJSON(): { baseUrl: string; credential: string } {
    return { baseUrl: this.#baseUrl, credential: "[redacted]" };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }

  // --- Operations: one per intent, named as the server names them -----------

  /** Who this caller is and what it can reach. The first call worth making: every identifier comes from here. Read it with `into(out, Kind.Me)`. */
  describeMe(options?: CallOptions): Promise<ReadOutput> {
    return this.call("me.describe", {}, options);
  }

  /** Whether this credential is accepted, and as which agent. Smaller than `describeMe` on purpose. */
  health(options?: CallOptions): Promise<Health> {
    return this.call("health", {}, options);
  }

  /** The operations this deployment serves; worth one call at startup instead of a refusal mid-task. See `served`. */
  describeCatalog(options?: CallOptions): Promise<Catalog> {
    return this.call("catalog.describe", {}, options);
  }

  /** A folder's messages, oldest first in the order they were filed, with what triage needs. Read it with `into(out, Kind.Folder)`. */
  async listFolder(input: In, options?: CallOptions): Promise<ReadOutput> {
    requireId(input.in, Prefix.Agent, "listFolder");
    return this.call("folder.list", input, options);
  }

  /** One message, rendered and structured. With `Render.Parts`, read it with `into(out, Kind.Message)`. */
  async describeMessage(input: ByID, options?: CallOptions): Promise<ReadOutput> {
    requireId(input.id, Prefix.Message, "describeMessage");
    return this.call("message.describe", input, options);
  }

  /**
   * A conversation's most recent messages in the order they were sent, each
   * cut at 4000 characters. `truncated` means older messages were left out.
   */
  async describeThread(input: ByID, options?: CallOptions): Promise<ReadOutput> {
    requireId(input.id, Prefix.Thread, "describeThread");
    return this.call("thread.describe", input, options);
  }

  /**
   * One part of a message. `PartMode.Text` (the default) renders a text part
   * under the same banner as a body, at most its first 2 MiB; `PartMode.Bytes`
   * returns it whole or refuses it (guard "part_size"). Read it with
   * `into(out, Kind.Part)`.
   */
  async describePart(input: ByID, options?: CallOptions): Promise<ReadOutput> {
    requireId(input.id, Prefix.Message, "describePart");
    if (!input.part) throw preflight(BudErrorCodes.Invalid, "describePart needs a part");
    return this.call("part.describe", input, options);
  }

  /** A mailbox's own state, by its agent's identifier. Read it with `into(out, Kind.Mailbox)`. */
  async describeMailbox(input: ByID, options?: CallOptions): Promise<ReadOutput> {
    requireId(input.id, Prefix.Agent, "describeMailbox");
    return this.call("mailbox.describe", input, options);
  }

  /** Who a mailbox has exchanged mail with; takes `q`, `limit` and `cursor`. Read it with `into(out, Kind.Corr)`. */
  async listCorrespondents(input: In, options?: CallOptions): Promise<ReadOutput> {
    requireId(input.in, Prefix.Agent, "listCorrespondents");
    return this.call("correspondent.list", input, options);
  }

  /**
   * Mark a message read or unread, or replace its labels. A
   * `precondition_failed` means other label writes kept landing first; the
   * request is safe to repeat as it was. Retried on a failed connection only
   * with an idempotency key.
   */
  async updateMessage(input: Change, options?: CallOptions): Promise<PutOutput> {
    requireId(input.id, Prefix.Message, "updateMessage");
    if (input.changes === undefined || input.changes === null) {
      throw preflight(BudErrorCodes.Invalid, "updateMessage needs changes");
    }
    return this.call("message.update", input, options);
  }

  /**
   * Compose and send. The server queues the message or refuses it, naming the
   * guard. Pass an idempotency key on every send: without one a retried
   * timeout is a second message, and this SDK never retries a send without one.
   */
  async send(input: SendInput, options?: CallOptions): Promise<SendOutput> {
    const recipients = (input.to?.length ?? 0) + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0);
    if (recipients === 0 && !input.in_reply_to) {
      throw preflight(
        BudErrorCodes.Invalid,
        "send needs a recipient in to, cc or bcc, or in_reply_to for a reply",
      );
    }
    return this.call("send", input, options);
  }

  /**
   * Block until something happens, or until the window closes. The window is
   * `timeout_s` (at most and by default `MAX_WAIT_SECONDS`) and starts once the
   * stream is open. Returns the first batch with events, whole; pass its cursor
   * to the next wait. An empty answer is success (`isEmptyWait`), and a refusal
   * is a value. With `types` or `agent_part` set, a quiet wait over a busy
   * mailbox may return the cursor it started from; filter on the caller's side
   * when the excluded traffic is heavy. A long-lived consumer should `watch`.
   */
  async wait(input: WaitInput = {}, options?: CallOptions): Promise<WaitOutput> {
    return waitOnce(this.#transport, input, options?.signal, this.authorizationFor(options));
  }

  /**
   * Open the journal stream. A refusal before it opens is thrown as the
   * server's BudError; once open, failures surface through iteration. Close it,
   * break out of the loop, or abort the signal to release the connection.
   */
  async watch(input: WaitInput = {}, options?: CallOptions): Promise<WatchStream> {
    return watchJournal(this.#transport, input, options?.signal, this.authorizationFor(options));
  }

  // --- Plumbing --------------------------------------------------------------

  private authorizationFor(options: CallOptions | undefined): string | undefined {
    if (this.#credential.kind === "forwarding") return options?.authorization;
    if (options?.authorization !== undefined) {
      throw preflight(
        BudErrorCodes.Invalid,
        "this client carries its own key; pass a per-call authorization only to BudClient.forwarding()",
      );
    }
    return this.#credential.header;
  }

  private async call<T extends { error?: BudError }>(
    op: string,
    input: object,
    options: CallOptions | undefined,
  ): Promise<T> {
    const authorization = this.authorizationFor(options);
    const body = wireBody(op, input);
    const signal = options?.signal;
    const exchange = await this.#transport.exchange(op, input, body, { signal, authorization });
    try {
      const raw = await readText(exchange.response, MAX_RESPONSE_BYTES, signal);
      return decodeEnvelope<T>(exchange.response.status, raw, exchange.requestId);
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      throw err;
    } finally {
      exchange.end();
    }
  }
}

/**
 * Read the operation's own output out of a response.
 *
 * An empty or undecodable body is `malformed_response` (or `unauthorized` at
 * 401), thrown. A refusal is a value: everything the server said is kept, and
 * only what the envelope cannot carry — the status, and the request id when the
 * body has none — is filled in. A success at a failing status cannot be
 * believed either way, so it is thrown as malformed rather than guessed at.
 */
export function decodeEnvelope<T extends { error?: BudError }>(
  status: number,
  raw: string,
  requestId: string,
): T {
  if (raw.trim() === "") throw errorFrom(status, raw, requestId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw errorFrom(status, raw, requestId);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw errorFrom(status, raw, requestId);
  }

  const { error: rawError, ...rest } = withoutNulls(parsed) as Record<string, unknown>;
  if (rawError !== undefined && rawError !== null) {
    const error = refusalFrom(rawError, status, requestId);
    if (!error) throw errorFrom(status, raw, requestId);
    return { ...rest, error } as T;
  }
  if (status < 200 || status > 299) throw errorFrom(status, raw, requestId);
  return rest as T;
}

/**
 * Refuse an identifier of the wrong kind before sending. The prefix is the
 * kind, so a pasted thread id where a message one belongs costs no round trip.
 * The rest is the server's parser's job; duplicating it would be a second grammar.
 */
function requireId(id: string | undefined, prefix: string, op: string): void {
  if (!id) throw preflight(BudErrorCodes.Invalid, `${op} needs an id`);
  if (!id.startsWith(prefix)) {
    throw preflight(
      BudErrorCodes.Invalid,
      `${op} needs an identifier beginning ${JSON.stringify(prefix)}, got ${JSON.stringify(firstPrefix(id))}`,
    );
  }
}

/** An identifier up to and including its underscore, so a refusal names what arrived without quoting all of it. */
function firstPrefix(id: string): string {
  const i = id.indexOf("_");
  if (i >= 0) return id.slice(0, i + 1);
  return id.length > 16 ? id.slice(0, 16) : id;
}

function readEnv(name: string): string {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return (proc?.env?.[name] ?? "").trim();
}

function defaultFetch(): typeof fetch {
  const f = (globalThis as { fetch?: typeof fetch }).fetch;
  if (!f) {
    throw new Error(
      "bud: no global fetch; Node 18+ provides one, otherwise pass `fetch` in the options",
    );
  }
  return f.bind(globalThis);
}
