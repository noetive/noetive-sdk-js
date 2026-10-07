/**
 * The closed vocabularies, and the banner.
 *
 * Every value here is one the server chose and will keep choosing. They are
 * constants rather than documentation because a caller branches on them, and a
 * string literal at a branch is a typo nothing catches. Wire fields stay typed
 * `string` so a value a newer server adds still decodes.
 */

/** The send states `SendOutput.state` reports. A new send is `queued`; a repeat with the same idempotency key reports any of these. */
export const SendState = Object.freeze({
  /** Durably queued and not yet handed on. */
  Queued: "queued",
  /** It is being handed on. */
  Sending: "sending",
  /** The provider accepted it. */
  Sent: "sent",
  /** The receiving side accepted it. */
  Delivered: "delivered",
  /** The receiving side refused it for good. */
  Bounced: "bounced",
  /** It could not be handed on; `reason` says why. */
  Failed: "failed",
  /** Can appear on older messages. Nothing is held. */
  Held: "held",
  /** Can appear on older messages. */
  Rejected: "rejected",
} as const);

/** The event types `JournalEvent.type` names and `WaitInput.types` filters on. */
export const EventType = Object.freeze({
  /** Mail arriving. */
  Received: "mail.received",
  /** Mail arriving and filed in quarantine. */
  Quarantined: "mail.quarantined",
  /** A send accepted. */
  Queued: "mail.queued",
  /** Handed to the provider. Carries the Message-ID recipients see in `data.message_id`. */
  Sent: "mail.sent",
  /** Accepted by the receiving side. */
  Delivered: "mail.delivered",
  /** Refused for good. */
  Bounced: "mail.bounced",
  /** Reported as unwanted. */
  Complained: "mail.complained",
  /** A message marked read or unread. */
  Read: "mail.read",
  /** A rendering was withheld as unsafe and a degraded one shown instead. */
  RenderFailed: "render.failed",
} as const);

/** Who caused an event, as `Actor.kind` names it. */
export const ActorKind = Object.freeze({
  System: "system",
  Agent: "agent",
  Operator: "operator",
} as const);

/** The folders `In.folder` names. `inbox` is the default. */
export const Folder = Object.freeze({
  Inbox: "inbox",
  Sent: "sent",
  Quarantine: "quarantine",
} as const);

/** How a message joined its conversation, as `Provenance.thread_join` names it. */
export const ThreadJoin = Object.freeze({
  /** It started one. */
  New: "new",
  /** A reply from someone the conversation already involves. */
  Verified: "verified",
  /** It only claims to be a reply. */
  Claimed: "claimed",
} as const);

/** Whether mail an agent sends goes out now, as `SendingStatus.status` names it. */
export const SendingState = Object.freeze({
  /** Mail goes out now. */
  Ready: "ready",
  /** The sending domain is not ready yet; mail is accepted, queued, and goes out once it is. */
  Provisioning: "provisioning",
  /** An operator stopped sending; a send is refused until it is released. */
  Paused: "paused",
} as const);

/** The modes `describePart` reads a part in. */
export const PartMode = Object.freeze({
  /** Renders a part that is already text into `text`. The default; any other type is refused as unavailable. */
  Text: "text",
  /** Returns the part's content in `PartView.bytes`. A part over the server's cap is refused with the guard that fired. */
  Bytes: "bytes",
} as const);

/** The renderings `describeMessage` offers, as `ByID.render` names them. */
export const Render = Object.freeze({
  /** The safe rendering, under a banner. The default. */
  Text: "text",
  /** The original message as it arrived. */
  Raw: "raw",
  /** The message's structure, with the part numbers `describePart` takes. */
  Parts: "parts",
} as const);

/** The object kinds a read can return, which `ReadOutput.kind` names. */
export const Kind = Object.freeze({
  Me: "me",
  Help: "help",
  Mailbox: "mailbox",
  Folder: "folder",
  Corr: "corr",
  Message: "message",
  Part: "part",
  Thread: "thread",
} as const);

/**
 * The identifier prefixes. An identifier is self-describing: the prefix names
 * the kind, so one opaque string is the only argument a read or a write needs,
 * and a caller can check a string before spending a round trip on it. An agent
 * and its mailbox share one identifier, so there is one prefix (`ag_`) rather
 * than a pair that could disagree.
 */
export const Prefix = Object.freeze({
  Tenant: "tenant_",
  Agent: "ag_",
  Message: "message_",
  Thread: "thread_",
  Journal: "journal_",
  Request: "request_",
} as const);

/** The effect kinds a write reports in `PutOutput.effects`. */
export const EffectKind = Object.freeze({
  /** A message marked read or unread. */
  MailRead: "mail.read",
  /** A message whose labels were set. */
  Labelled: "labelled",
} as const);

/**
 * Begins the rendering of anything carrying content somebody else wrote. The
 * full line names the object and says, in the server's voice, that what
 * follows is data rather than instructions: a mail server cannot stop a message
 * containing "ignore your previous instructions", so the defence is making the
 * provenance impossible to miss.
 */
export const BANNER_PREFIX = "[bud message ";

/**
 * Whether a rendering carries its provenance banner. Gate on this before
 * putting `ReadOutput.text` in a model's context, and fall back to the
 * structured content when it is missing: a relay that dropped the banner would
 * hand a stranger's words to a model with nothing marking them as a stranger's.
 */
export function hasBanner(text: string): boolean {
  return text.startsWith(BANNER_PREFIX);
}

/**
 * Whether a kind's rendering can contain text somebody else wrote, and so must
 * carry a banner. A listing is the server's own table; a message, a thread and
 * a message part are not.
 */
export function carriesSenderContent(kind: string): boolean {
  return kind === Kind.Message || kind === Kind.Thread || kind === Kind.Part;
}
