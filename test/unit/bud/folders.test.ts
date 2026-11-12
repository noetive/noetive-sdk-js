/**
 * Folders a mailbox makes, and moving mail between them.
 */

import { describe, expect, it } from "vitest";
import {
  BudError,
  BudErrorCodes,
  EffectKind,
  EventType,
  Folder,
  NoRetry,
  TransientRetry,
} from "../../../src/bud/index.js";
import { answer, budClient, fakeFetch } from "./server.js";

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("folders", () => {
  // Covers: each folder call reaches its own operation and carries the mailbox,
  // folder and key. Why: a path or field slip is a call that does something else.
  it("createFolder and deleteFolder post to their own paths with the mailbox and folder", async () => {
    const srv = fakeFetch(() => answer('{"ref":"ag_01x/receipts"}'));
    const c = budClient(srv.fetch);
    await c.createFolder({ in: "ag_01x", folder: "receipts", idempotency_key: "k1" });
    await c.deleteFolder({ in: "ag_01x", folder: "receipts" });
    expect(srv.received.map((r) => [r.path, r.body])).toEqual([
      ["/v1/folder.create", { in: "ag_01x", folder: "receipts", idempotency_key: "k1" }],
      ["/v1/folder.delete", { in: "ag_01x", folder: "receipts" }],
    ]);
  });

  // Covers: the effect the server reports reaches the caller, and a repeat that
  // changed nothing comes back with none. Why: callers branch on effects to tell
  // "made it" from "was already there".
  it("reports the effect when a folder is made or removed, and none for a repeat", async () => {
    const replies = [
      '{"ref":"ag_01x/receipts","effects":[{"kind":"folder.created","count":1}]}',
      '{"ref":"ag_01x/receipts"}',
      '{"ref":"ag_01x/receipts","effects":[{"kind":"folder.deleted","count":1}]}',
    ];
    const srv = fakeFetch(() => answer(replies.shift() ?? "{}"));
    const c = budClient(srv.fetch);
    const made = await c.createFolder({ in: "ag_01x", folder: "receipts" });
    expect(made.effects?.map((e) => e.kind)).toEqual([EffectKind.FolderCreated]);
    const again = await c.createFolder({ in: "ag_01x", folder: "receipts" });
    expect(again.effects ?? []).toEqual([]);
    const gone = await c.deleteFolder({ in: "ag_01x", folder: "receipts" });
    expect(gone.effects?.map((e) => e.kind)).toEqual([EffectKind.FolderDeleted]);
  });

  // Covers: a refusal on a folder call is a value carrying the server's code.
  // Why: past the folder limit or on a folder holding mail the caller must be
  // able to read the refusal rather than catch an exception.
  it("a refused folder call resolves with the server's refusal", async () => {
    const srv = fakeFetch(() =>
      answer('{"error":{"code":"precondition_failed","message":"still holds mail"}}', 409),
    );
    const out = await budClient(srv.fetch).deleteFolder({ in: "ag_01x", folder: "receipts" });
    expect(out.error?.code).toBe(BudErrorCodes.PreconditionFailed);
  });
});

describe("moveMessage", () => {
  // Covers: a move is a message.update whose changes hold only the folder.
  // Why: anything else in the change would also mark or label the message.
  it("sends message.update with only a folder change", async () => {
    const srv = fakeFetch(() =>
      answer('{"ref":"message_01x","effects":[{"kind":"moved","count":1}]}'),
    );
    const out = await budClient(srv.fetch).moveMessage({
      id: "message_01x",
      folder: "receipts",
      idempotency_key: "k2",
    });
    expect(srv.received).toHaveLength(1);
    expect(srv.received[0]?.path).toBe("/v1/message.update");
    expect(srv.received[0]?.body).toEqual({
      id: "message_01x",
      changes: { folder: "receipts" },
      idempotency_key: "k2",
    });
    expect(out.effects?.map((e) => e.kind)).toEqual([EffectKind.Moved]);
  });

  // Covers: moving to where the message already is reports no effect.
  // Why: callers must be able to treat a repeat as success without an effect.
  it("reports no effect for a move to the same folder", async () => {
    const srv = fakeFetch(() => answer('{"ref":"message_01x"}'));
    const out = await budClient(srv.fetch).moveMessage({ id: "message_01x", folder: Folder.Inbox });
    expect(out.error).toBeUndefined();
    expect(out.effects ?? []).toEqual([]);
  });

  // Covers: a move without a key is not retried after a failed connection, a
  // keyed one is. Why: the move goes through updateMessage's retry rules and
  // must not quietly become retryable without a key.
  it("is retried on a failed connection only with an idempotency key", async () => {
    const policy = new TransientRetry({ attempts: 3, backoffMs: [1] });
    for (const [key, want] of [
      [undefined, 1],
      ["k", 4],
    ] as const) {
      let calls = 0;
      const down = (async () => {
        calls++;
        throw new TypeError("connection reset");
      }) as typeof fetch;
      await caught(
        budClient(down, { retry: policy }).moveMessage({
          id: "message_01x",
          folder: "receipts",
          ...(key ? { idempotency_key: key } : {}),
        }),
      );
      expect(calls).toBe(want);
    }
  });
});

describe("folder preflight refuses before sending", () => {
  const cases: [string, (c: ReturnType<typeof budClient>) => Promise<unknown>][] = [
    [
      "createFolder with a message id as the mailbox",
      (c) => c.createFolder({ in: "message_01x", folder: "receipts" }),
    ],
    ["createFolder with no folder", (c) => c.createFolder({ in: "ag_01x", folder: "" })],
    [
      "deleteFolder with a thread id as the mailbox",
      (c) => c.deleteFolder({ in: "thread_01x", folder: "receipts" }),
    ],
    ["deleteFolder with no mailbox", (c) => c.deleteFolder({ in: "", folder: "receipts" })],
    ["deleteFolder with no folder", (c) => c.deleteFolder({ in: "ag_01x", folder: "" })],
    ["moveMessage with no folder", (c) => c.moveMessage({ id: "message_01x", folder: "" })],
    ["moveMessage of a thread id", (c) => c.moveMessage({ id: "thread_01x", folder: "receipts" })],
  ];
  // Covers: each refusal below is thrown with status 0 and nothing reaches the
  // server. Why: a wrong kind of id or a missing folder costs no round trip.
  for (const [name, call] of cases) {
    it(name, async () => {
      const srv = fakeFetch(() => answer("{}"));
      const err = await caught(call(budClient(srv.fetch, { retry: new NoRetry() })));
      expect(BudError.is(err, BudErrorCodes.Invalid)).toBe(true);
      expect((err as BudError).httpStatus).toBe(0);
      expect(srv.received).toHaveLength(0);
    });
  }
});

describe("folder vocabulary", () => {
  // Covers: the names the server uses for the new event and effects.
  // Why: callers branch on these constants; a typo here is silent.
  it("names the move event and the folder effects as the server does", () => {
    expect(EventType.Moved).toBe("mail.moved");
    expect(EffectKind.Moved).toBe("moved");
    expect(EffectKind.FolderCreated).toBe("folder.created");
    expect(EffectKind.FolderDeleted).toBe("folder.deleted");
  });
});
