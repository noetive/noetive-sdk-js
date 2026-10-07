/**
 * The wire contract, checked rather than hoped for.
 *
 * The server describes its own shapes — per type, each field's JSON name, wire
 * kind and whether it is omitempty — and that description is vendored under
 * test/fixtures/bud. TypeScript has no reflection to rebuild it from, so each
 * contract type is pinned by two fixtures the compiler holds honest:
 *
 * - a full one, typed `Required<T>`, so it must set every field the type
 *   declares; it must encode exactly the golden's names, each value of the
 *   golden's kind. A field renamed or dropped on either side fails here.
 * - a minimal one, typed `T`, so it must set every field the type requires;
 *   it must encode exactly the golden's always-present fields. A field whose
 *   optionality disagrees with the server fails here.
 *
 * Requests the client sends go through the client's own encoder, so what is
 * checked is what goes on the wire.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Actor,
  BudError,
  type BudErrorBody,
  CONTRACT_VERSION,
  type Conversation,
  type Effect,
  type EventData,
  type JournalEvent,
  type Listing,
  type Me,
  type Provenance,
  type PutInput,
  type PutOutput,
  type ReadInput,
  type ReadOutput,
  type SendInput,
  type SendOutput,
  type Summary,
  type WaitInput,
  type WaitOutput,
} from "../../../src/bud/index.js";
import { wireObject } from "../../../src/bud/request.js";

const GOLDEN = new URL("../../fixtures/bud/contract.golden", import.meta.url);

interface Field {
  kind: string;
  omitempty: boolean;
}

function parseGolden(text: string): { version: string; types: Map<string, Map<string, Field>> } {
  const lines = text.split("\n").filter((l) => l !== "");
  const types = new Map<string, Map<string, Field>>();
  let current: Map<string, Field> | undefined;
  for (const line of lines.slice(1)) {
    if (!line.startsWith("  ")) {
      current = new Map();
      types.set(line, current);
      continue;
    }
    const [name, rest] = line.trim().split(" ") as [string, string];
    const [kind, opt] = rest.split(",") as [string, string | undefined];
    current?.set(name, { kind, omitempty: opt === "omitempty" });
  }
  return { version: lines[0] ?? "", types };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Whether a decoded JSON value is of the golden's wire kind. Lists and maps must be non-empty, so their elements are checked too. */
function ofKind(kind: string, v: unknown): boolean {
  if (kind === "string") return typeof v === "string";
  if (kind === "number") return typeof v === "number";
  if (kind === "bool") return typeof v === "boolean";
  if (kind === "json") return v !== undefined;
  if (kind === "object") return isObject(v);
  if (kind.startsWith("[]")) {
    return Array.isArray(v) && v.length > 0 && v.every((e) => ofKind(kind.slice(2), e));
  }
  const map = /^map\[string\](.+)$/.exec(kind);
  if (map) {
    const elem = map[1] as string;
    return (
      isObject(v) && Object.keys(v).length > 0 && Object.values(v).every((e) => ofKind(elem, e))
    );
  }
  throw new Error(`the golden names a kind this test does not know: ${kind}`);
}

const encodeJSON = (v: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(v));

const errorBody: Required<BudErrorBody> = {
  code: "rate_limited",
  message: "spent",
  hint: "wait",
  request_id: "request_01x",
  retry_after_ms: 1000,
  current: { read: true },
  version: "v1",
  field: "/to",
  guard: "virus",
  counter: "per_hour",
};
const refusal = new BudError(errorBody, 429);

const provenance: Required<Provenance> = {
  spf: "pass",
  dkim: "pass",
  dmarc: "pass",
  aligned: true,
  in_tenant: true,
  known: true,
  thread_join: "verified",
  folder: "inbox",
  removed: { quoted: 1 },
};
const actor: Required<Actor> = { kind: "agent", agent: "ag_01x" };
const eventData: Required<EventData> = {
  from: "a@b.example",
  subject: "s",
  aligned: true,
  in_tenant: true,
  known: true,
  agent_part: true,
  folder: "inbox",
  guard: "g",
  counter: "c",
  reason: "r",
  state: "sent",
  provider: "p",
  message_id: "abc@example.com",
};
const event: Required<JournalEvent> = {
  id: "journal_01x",
  tenant: "tenant_01x",
  ts: "2026-01-02T03:04:05Z",
  seq: 42,
  type: "mail.received",
  mailbox: "ag_01x",
  message: "message_01x",
  thread: "thread_01x",
  actor,
  corr: "request_01x",
  data: eventData,
};
const summary: Required<Summary> = {
  message: "message_01x",
  thread: "thread_01x",
  subject: "s",
  date: "2026-01-02T03:04:05Z",
  from: "a@b.example",
  from_name: "A",
  aligned: true,
  in_tenant: true,
  known: true,
  join: "new",
  attachments: 1,
  unread: true,
  incomplete: true,
};

interface Case {
  full: Record<string, unknown>;
  minimal: Record<string, unknown>;
}

const send = (v: SendInput) => wireObject("send", v);
const watch = (v: WaitInput) => wireObject("watch", v);

/** One per contract type, in the server's order. */
const cases: Record<string, Case> = {
  WaitInput: {
    full: watch({
      cursor: "41",
      mailbox: "ag_01x",
      timeout_s: 5,
      types: ["mail.received"],
      agent_part: true,
    } satisfies Required<WaitInput>),
    minimal: watch({} satisfies WaitInput),
  },
  WaitOutput: {
    full: encodeJSON({
      events: [event],
      cursor: "42",
      error: refusal,
    } satisfies Required<WaitOutput>),
    minimal: encodeJSON({ cursor: "" } satisfies WaitOutput),
  },
  ReadInput: {
    full: encodeJSON({
      ref: "message_01x",
      max_chars: 10,
      cursor: "c",
    } satisfies Required<ReadInput>),
    minimal: encodeJSON({ ref: "" } satisfies ReadInput),
  },
  ReadOutput: {
    full: encodeJSON({
      ref: "message_01x",
      kind: "message",
      text: "t",
      content: { a: 1 },
      provenance,
      cursor: "c",
      truncated: true,
      version: "v",
      error: refusal,
    } satisfies Required<ReadOutput>),
    minimal: encodeJSON({} satisfies ReadOutput),
  },
  PutInput: {
    full: encodeJSON({
      ref: "message_01x",
      body: { read: true },
      version: "v",
      idempotency_key: "k",
    } satisfies Required<PutInput>),
    minimal: encodeJSON({ ref: "", body: {} } satisfies PutInput),
  },
  PutOutput: {
    full: encodeJSON({
      ref: "message_01x",
      version: "v",
      created: true,
      effects: [{ kind: "mail.read", count: 1, ref: "message_01x" }],
      error: refusal,
    } satisfies Required<PutOutput>),
    minimal: encodeJSON({} satisfies PutOutput),
  },
  SendInput: {
    full: send({
      to: ["a@b.example"],
      subject: "s",
      text: "t",
      html: "<p>t</p>",
      cc: ["c@b.example"],
      bcc: ["d@b.example"],
      from: "me@b.example",
      on_behalf_of: "ag_02x",
      in_reply_to: "message_01p",
      reply_all: true,
      attach: ["message_01p/part/2"],
      agent: { intent: "ask" },
      idempotency_key: "k",
    } satisfies Required<SendInput>),
    minimal: send({} satisfies SendInput),
  },
  SendOutput: {
    full: encodeJSON({
      message: "message_01x",
      thread: "thread_01x",
      state: "queued",
      reason: "provisioning",
      remaining: { per_hour: 29 },
      error: refusal,
    } satisfies Required<SendOutput>),
    minimal: encodeJSON({} satisfies SendOutput),
  },
  Error: {
    full: encodeJSON(refusal),
    minimal: encodeJSON(new BudError({ code: "", message: "" } satisfies BudErrorBody)),
  },
  Provenance: {
    full: encodeJSON(provenance),
    minimal: encodeJSON({ aligned: false, in_tenant: false, known: false } satisfies Provenance),
  },
  Effect: {
    full: encodeJSON({ kind: "labelled", count: 1, ref: "message_01x" } satisfies Required<Effect>),
    minimal: encodeJSON({ kind: "" } satisfies Effect),
  },
  JournalEvent: {
    full: encodeJSON(event),
    minimal: encodeJSON({
      id: "",
      tenant: "",
      ts: "",
      seq: 0,
      type: "",
      mailbox: "",
      message: "",
      thread: "",
      actor: { kind: "", agent: "" },
      data: {},
    } satisfies JournalEvent),
  },
  EventData: {
    full: encodeJSON(eventData),
    minimal: encodeJSON({} satisfies EventData),
  },
  Actor: {
    full: encodeJSON(actor),
    minimal: encodeJSON({ kind: "", agent: "" } satisfies Actor),
  },
  Me: {
    full: encodeJSON({
      agent: "ag_01x",
      tenant: "tenant_01x",
      kind: "agent",
      name: "n",
      addresses: ["a@b.example"],
      mailbox: "ag_01x",
      readable_mailboxes: ["ag_01x"],
      scopes: ["mail"],
      granted: ["ag_02x"],
      limits: { per_hour: 30 },
      sending: { status: "ready" },
    } satisfies Required<Me>),
    minimal: encodeJSON({ agent: "", tenant: "" } satisfies Me),
  },
  Listing: {
    full: encodeJSON({
      mailbox: "ag_01x",
      folder: "inbox",
      messages: [summary],
    } satisfies Required<Listing>),
    minimal: encodeJSON({ mailbox: "", folder: "" } satisfies Listing),
  },
  Conversation: {
    full: encodeJSON({
      thread: "thread_01x",
      messages: [summary],
    } satisfies Required<Conversation>),
    minimal: encodeJSON({ thread: "" } satisfies Conversation),
  },
  Summary: {
    full: encodeJSON(summary),
    minimal: encodeJSON({
      message: "",
      date: "",
      aligned: false,
      in_tenant: false,
      known: false,
    } satisfies Summary),
  },
};

const golden = parseGolden(readFileSync(GOLDEN, "utf8"));

describe("the wire contract matches the server's", () => {
  it("is the generation this SDK implements", () => {
    expect(golden.version).toBe(CONTRACT_VERSION);
  });

  it("covers every type the server lists, and no other", () => {
    expect(Object.keys(cases)).toEqual([...golden.types.keys()]);
  });

  for (const [name, fields] of golden.types) {
    describe(name, () => {
      const c = cases[name] as Case;

      it("a full value encodes exactly the server's field names, each of its kind", () => {
        expect(Object.keys(c.full).sort()).toEqual([...fields.keys()].sort());
        for (const [field, { kind }] of fields) {
          expect(ofKind(kind, c.full[field]), `${name}.${field} should be ${kind}`).toBe(true);
        }
      });

      it("a minimal value encodes exactly the fields the server always sends", () => {
        const always = [...fields].filter(([, f]) => !f.omitempty).map(([k]) => k);
        expect(Object.keys(c.minimal).sort()).toEqual(always.sort());
      });
    });
  }
});
