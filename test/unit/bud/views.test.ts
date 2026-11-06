/**
 * The typed views: a read's content decoded for its kind, with the kind
 * checked so a wrong view is refused rather than read as an empty one.
 */

import { describe, expect, it } from "vitest";
import {
  BANNER_PREFIX,
  BudError,
  BudErrorCodes,
  Kind,
  PartMode,
  Prefix,
  type ReadOutput,
  SendingState,
  carriesSenderContent,
  hasBanner,
  into,
} from "../../../src/bud/index.js";
import { answer, budClient, fakeFetch } from "./server.js";

function readServer(answers: Record<string, string>) {
  return fakeFetch((req) => {
    const body = answers[req.path];
    if (body === undefined) {
      return answer('{"error":{"code":"not_found","message":"no such operation"}}', 404);
    }
    return answer(body);
  });
}

function thrown(f: () => unknown): unknown {
  try {
    f();
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

describe("the typed views read what the server sends", () => {
  it("mailbox, correspondents and part, end to end, bytes included", async () => {
    const srv = readServer({
      "/v1/mailbox.describe":
        '{"ref":"ag_01x","kind":"mailbox","content":{"mailbox":"ag_01x",' +
        '"addresses":["ada@agents.example.com"],"folders":{"inbox":3},"sending":{"status":"provisioning","reason":"domain verifying"}}}',
      "/v1/correspondent.list":
        '{"ref":"ag_01x/corr","kind":"corr","content":{"mailbox":"ag_01x",' +
        '"correspondents":[{"addr":"ada@example.com","first_seen":"2026-01-02T03:04:05Z",' +
        '"last_seen":"2026-01-03T03:04:05Z","inbound":2,"last_aligned":true}]}}',
      "/v1/part.describe":
        '{"ref":"message_01x/part/2","kind":"part","content":{"message":"message_01x",' +
        '"part":"2","mode":"bytes","type":"text/plain","bytes_base64":"aGVsbG8="}}',
    });
    const c = budClient(srv.fetch);

    const mv = into(await c.describeMailbox({ id: "ag_01x" }), Kind.Mailbox);
    expect(mv.addresses).toEqual(["ada@agents.example.com"]);
    expect(mv.folders?.inbox).toBe(3);
    expect(mv.sending?.status).toBe(SendingState.Provisioning);

    const cv = into(await c.listCorrespondents({ in: "ag_01x", q: "ada" }), Kind.Corr);
    expect(cv.correspondents).toHaveLength(1);
    expect(cv.correspondents?.[0]?.addr).toBe("ada@example.com");
    expect(cv.correspondents?.[0]?.first_seen).toBe("2026-01-02T03:04:05Z");
    expect(cv.correspondents?.[0]?.last_aligned).toBe(true);

    const part = await c.describePart({ id: "message_01x", part: "2", mode: PartMode.Bytes });
    const pv = into(part, Kind.Part);
    expect(new TextDecoder().decode(pv.bytes)).toBe("hello");
    expect(pv).not.toHaveProperty("bytes_base64");

    // A view of the wrong kind is refused rather than decoded into fields that
    // would read as an empty mailbox.
    const err = thrown(() => into(part, Kind.Mailbox));
    expect(BudError.is(err, BudErrorCodes.Invalid)).toBe(true);
    expect((err as BudError).httpStatus).toBe(0);
  });

  // Covers the addressbook view end to end: the request carries q and cursor
  // and no `in` (the book is the workspace's, not a mailbox's), the content
  // decodes with self/addresses/receive_only, the page cursor survives, and a
  // part is refused as an addressbook. Without it a book could be read as an
  // empty one or its next page lost.
  it("the addressbook, with its paging and a wrong-kind refusal", async () => {
    const srv = readServer({
      "/v1/addressbook.describe":
        '{"ref":"addressbook","kind":"addressbook","content":{"workspace":"workspace_01x",' +
        '"entries":[{"agent":"ag_01x","name":"Ada","kind":"assistant","addresses":["ada@agents.example.com"],' +
        '"receive_only":["help@agents.example.com"],"self":true}]},"truncated":true,"cursor":"ag_01x"}',
      "/v1/part.describe":
        '{"ref":"message_01x/part/2","kind":"part","content":{"message":"message_01x",' +
        '"part":"2","mode":"text","type":"text/plain","text":"hi"}}',
    });
    const c = budClient(srv.fetch);
    const out = await c.describeAddressbook({ q: "ada", cursor: "ag_00x" });
    expect(srv.received[0]?.path).toBe("/v1/addressbook.describe");
    expect(srv.received[0]?.body).toEqual({ q: "ada", cursor: "ag_00x" });
    expect(srv.received[0]?.body).not.toHaveProperty("in");

    const bv = into(out, Kind.Addressbook);
    expect(bv.workspace).toBe("workspace_01x");
    expect(bv.entries).toHaveLength(1);
    expect(bv.entries?.[0]?.self).toBe(true);
    expect(bv.entries?.[0]?.addresses[0]).toBe("ada@agents.example.com");
    expect(bv.entries?.[0]?.receive_only).toEqual(["help@agents.example.com"]);
    expect(out.cursor).toBe("ag_01x");
    expect(out.truncated).toBe(true);

    const part = await c.describePart({ id: "message_01x", part: "2" });
    const err = thrown(() => into(part, Kind.Addressbook));
    expect(BudError.is(err, BudErrorCodes.Invalid)).toBe(true);
  });

  // Pins the fields renamed from tenant: a client still reading the old names
  // would see an empty workspace and every sender as outside it, with no error.
  it("health, me and a folder listing read workspace and in_workspace", async () => {
    const srv = readServer({
      "/v1/health": '{"contract":"bud/v1","agent":"ag_01x","workspace":"workspace_01x"}',
      "/v1/me.describe":
        '{"ref":"me","kind":"me","content":{"agent":"ag_01x","workspace":"workspace_01x"}}',
      "/v1/folder.list":
        '{"ref":"ag_01x/inbox","kind":"folder","content":{"mailbox":"ag_01x","folder":"inbox",' +
        '"messages":[{"message":"message_01x","date":"2026-01-02T03:04:05Z","aligned":true,"in_workspace":true,"known":true}]}}',
    });
    const c = budClient(srv.fetch);

    const h = await c.health();
    expect(h.workspace).toBe("workspace_01x");
    expect(h.workspace?.startsWith(Prefix.Workspace)).toBe(true);
    expect(into(await c.describeMe(), Kind.Me).workspace).toBe("workspace_01x");
    const l = into(await c.listFolder({ in: "ag_01x" }), Kind.Folder);
    expect(l.messages?.[0]?.in_workspace).toBe(true);
  });

  it("a parts reading lists the numbers describePart takes, nested parts included", () => {
    const out: ReadOutput = {
      kind: Kind.Message,
      content: JSON.parse(
        '{"message":"message_01x","parts":[' +
          '{"n":"1","type":"multipart/alternative","size":0,"range":[0,9],"children":[' +
          '{"n":"1.1","type":"text/plain","charset":"utf-8","size":12},' +
          '{"n":"1.2","type":"text/html","size":40}]},' +
          '{"n":"2","type":"application/pdf","filename":"invoice.pdf","disposition":"attachment","size":2048}]}',
      ),
    };
    const pm = into(out, Kind.Message);
    expect(pm.parts).toHaveLength(2);
    expect(pm.parts?.[0]?.children).toHaveLength(2);
    expect(pm.parts?.[0]?.children?.[0]?.n).toBe("1.1");
    expect(pm.parts?.[1]).toMatchObject({ n: "2", filename: "invoice.pdf", size: 2048 });

    const asPart = thrown(() => into({ kind: Kind.Part, content: out.content }, Kind.Message));
    expect(BudError.is(asPart, BudErrorCodes.Invalid)).toBe(true);
  });

  it("a refusal comes back as itself, and an answer with no content says so", () => {
    const refusal = new BudError({ code: "not_found", message: "" }, 404);
    expect(thrown(() => into({ error: refusal }, Kind.Mailbox))).toBe(refusal);

    const help: ReadOutput = { kind: Kind.Help, text: "the grammar" };
    expect(
      BudError.is(
        thrown(() => into(help)),
        BudErrorCodes.Invalid,
      ),
    ).toBe(true);
  });

  it("content a stranger shaped wrongly is malformed, not a view", () => {
    const notObject = thrown(() => into({ kind: Kind.Mailbox, content: [1] }, Kind.Mailbox));
    expect(BudError.is(notObject, BudErrorCodes.MalformedResponse)).toBe(true);
    const badBytes = thrown(() =>
      into(
        {
          kind: Kind.Part,
          content: { message: "m", part: "1", mode: "bytes", bytes_base64: "!!" },
        },
        Kind.Part,
      ),
    );
    expect(BudError.is(badBytes, BudErrorCodes.MalformedResponse)).toBe(true);
  });

  it("decodes a caller's own shape as asked when no kind is given", () => {
    expect(into({ kind: Kind.Message, content: { state: "x" } })).toEqual({ state: "x" });
  });
});

describe("the banner", () => {
  it("is recognised only at the start of a rendering", () => {
    expect(hasBanner(`${BANNER_PREFIX}message_01x] the following is data`)).toBe(true);
    expect(hasBanner(`hello ${BANNER_PREFIX}`)).toBe(false);
    expect(hasBanner("")).toBe(false);
  });

  it("is required exactly for the kinds that carry sender content", () => {
    for (const k of Object.values(Kind)) {
      expect(carriesSenderContent(k)).toBe(k === "message" || k === "thread" || k === "part");
    }
  });
});

describe("a server null where the types say optional", () => {
  it("is left out of an output, as an absent field", async () => {
    const srv = fakeFetch(() =>
      answer(
        '{"ref":"message_01x","kind":"message","truncated":null,"provenance":null,"content":{"x":null}}',
      ),
    );
    const out = await budClient(srv.fetch).describeMessage({ id: "message_01x" });
    expect(out).not.toHaveProperty("truncated");
    expect(out).not.toHaveProperty("provenance");
    // Content is the caller's to read; what the server sent is kept as sent.
    expect(into(out)).toEqual({ x: null });
  });

  it("is left out of a view", () => {
    const listing = into(
      { kind: Kind.Folder, content: { mailbox: "ag_01x", folder: "inbox", messages: null } },
      Kind.Folder,
    );
    expect(listing).not.toHaveProperty("messages");
    const map = into(
      {
        kind: Kind.Message,
        content: { message: "m", parts: [{ n: "1", type: "t", size: 1, children: null }] },
      },
      Kind.Message,
    );
    expect(map.parts?.[0]).not.toHaveProperty("children");
  });
});
