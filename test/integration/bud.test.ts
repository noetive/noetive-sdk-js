/**
 * The Bud client against production. Run:
 *
 *   NOETIVE_KEY_SECRET=keya_... npx vitest run test/integration/bud
 *
 * Never delivers mail; see bud-setup.ts for what it does and does not touch.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  type BudClient,
  BudErrorCodes,
  CONTRACT_VERSION,
  Folder,
  Kind,
  type Me,
  type PartInfo,
  PartMode,
  Prefix,
  Render,
  SendingState,
  hasBanner,
  into,
  served,
} from "../../src/bud/index.js";
import { answered, anyMessage, call, findMessage, hasBudKey, refused, setup } from "./bud-setup.js";

describe.skipIf(!hasBudKey())("Bud (integration)", () => {
  let c: BudClient;
  let me: Me;
  let mailbox: string;

  beforeAll(async () => {
    ({ c, me } = await setup());
    mailbox = me.mailbox as string;
  });

  it("health names the agent and the contract", async () => {
    const h = await c.health(call());
    answered("health", h.error);
    expect(h.contract).toBe(CONTRACT_VERSION);
    expect(h.agent).toBe(me.agent);
    expect(h.tenant).toBe(me.tenant);
  });

  it("the catalog serves every operation this client calls", async () => {
    const cat = await c.describeCatalog(call());
    answered("describeCatalog", cat.error);
    for (const op of [
      "me.describe",
      "health",
      "catalog.describe",
      "folder.list",
      "message.describe",
      "thread.describe",
      "part.describe",
      "mailbox.describe",
      "correspondent.list",
      "message.update",
      "send",
      "watch",
    ]) {
      expect(served(cat, op), `the catalog does not serve ${op}`).toBe(true);
    }
  });

  it("the mailbox describes itself", async () => {
    const out = await c.describeMailbox({ id: mailbox }, call());
    answered("describeMailbox", out.error);
    const mv = into(out, Kind.Mailbox);
    expect(mv.mailbox).toBe(mailbox);
    if (mv.sending) {
      expect(Object.values(SendingState)).toContain(mv.sending.status);
    }
  });

  it("every folder lists", async () => {
    for (const folder of [Folder.Inbox, Folder.Sent, Folder.Quarantine]) {
      const out = await c.listFolder({ in: mailbox, folder, limit: 5 }, call());
      answered(`listFolder ${folder}`, out.error);
      for (const s of into(out, Kind.Folder).messages ?? []) {
        expect(s.message.startsWith(Prefix.Message)).toBe(true);
      }
      if (!out.cursor) continue;
      const next = await c.listFolder(
        { in: mailbox, folder, limit: 5, cursor: out.cursor },
        call(),
      );
      answered(`listFolder ${folder} page 2`, next.error);
    }
  });

  it("correspondents list", async () => {
    const out = await c.listCorrespondents({ in: mailbox, limit: 5 }, call());
    answered("listCorrespondents", out.error);
    for (const cr of into(out, Kind.Corr).correspondents ?? []) {
      expect(cr.addr).not.toBe("");
      expect(cr.first_seen).not.toBe("");
    }
  });

  it("a message reads every way", async (ctx) => {
    const s = await anyMessage(c, me);
    if (!s) return ctx.skip();

    const text = await c.describeMessage({ id: s.message }, call());
    answered("describeMessage", text.error);
    expect(hasBanner(text.text ?? ""), `no banner: ${text.text?.slice(0, 60)}`).toBe(true);
    expect(text.provenance).toBeDefined();

    const parts = await c.describeMessage({ id: s.message, render: Render.Parts }, call());
    answered("describeMessage parts", parts.error);
    const pm = into(parts, Kind.Message);
    expect(pm.parts?.length ?? 0).toBeGreaterThan(0);

    const n = firstText(pm.parts ?? []);
    if (n) {
      const part = await c.describePart({ id: s.message, part: n, mode: PartMode.Bytes }, call());
      answered(`describePart ${n}`, part.error);
      const pv = into(part, Kind.Part);
      expect(pv.part).toBe(n);
      expect(pv.bytes?.byteLength ?? 0).toBe(pv.size ?? 0);
    }

    if (s.thread) {
      const thread = await c.describeThread({ id: s.thread, max_messages: 3 }, call());
      answered("describeThread", thread.error);
      const conv = into(thread, Kind.Thread);
      expect(conv.thread).toBe(s.thread);
      expect(conv.messages?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("marking a message as it already is changes nothing", async (ctx) => {
    const s = await anyMessage(c, me);
    if (!s) return ctx.skip();
    const unread = s.unread ?? false;
    const out = await c.updateMessage({ id: s.message, changes: { read: !unread } }, call());
    answered("updateMessage", out.error);
    const after = await findMessage(c, me, s.message);
    expect(after.unread ?? false).toBe(unread);
  });

  it("a quiet wait is success, with a cursor to resume from", async () => {
    const signal = AbortSignal.timeout(20_000);
    const start = Date.now();
    const out = await c.wait({ timeout_s: 2 }, { signal });
    answered("wait", out.error);
    expect(out.cursor).not.toBe("");
    expect(Date.now() - start).toBeLessThan(15_000);

    const again = await c.wait({ cursor: out.cursor, timeout_s: 1 }, { signal });
    answered("wait from the cursor", again.error);
  });

  it("a watch opens at a cursor", async () => {
    const st = await c.watch({ timeout_s: 1 }, { signal: AbortSignal.timeout(10_000) });
    try {
      expect(st.requestId).not.toBe("");
      expect(st.cursor(), "the stream opened without saying where it starts").not.toBe("");
    } finally {
      await st.close();
    }
  });

  it("refusals carry what to do next", async (ctx) => {
    const missing = await c.describeMessage({ id: "message_01aaaaaaaaaaaaaaaaaaaaaaaa" }, call());
    refused(
      "describeMessage of a message that does not exist",
      missing.error,
      BudErrorCodes.NotFound,
    );

    const folder = await c.listFolder({ in: mailbox, folder: "no-such-folder" }, call());
    refused("listFolder of a folder that does not exist", folder.error, BudErrorCodes.Invalid);

    const to = me.addresses?.[0];
    if (!to) return ctx.skip();
    // Refused before anything is queued: attaching is not served.
    const attach = await c.send(
      {
        to: [to],
        subject: "integration: refused",
        text: "never sent",
        attach: ["message_01aaaaaaaaaaaaaaaaaaaaaaaaaa/part/2"],
        idempotency_key: "integration-refused-attach",
      },
      call(),
    );
    const e = refused("send with an attachment", attach.error, BudErrorCodes.Invalid);
    expect(e.field).toBe("/attach");
  });
});

/** The number of the first leaf text part small enough to read whole, or "". */
function firstText(parts: PartInfo[]): string {
  for (const p of parts) {
    if (p.children?.length) {
      const n = firstText(p.children);
      if (n) return n;
      continue;
    }
    if (p.type.startsWith("text/") && p.size > 0 && p.size < 1 << 20) return p.n;
  }
  return "";
}
