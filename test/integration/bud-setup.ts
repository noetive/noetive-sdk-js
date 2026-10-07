/**
 * Bud integration harness.
 *
 * Drives the client against the production endpoint, hardcoded on purpose: the
 * suite exists to catch drift between this client and the real service, and an
 * override would defeat that. Gated on NOETIVE_KEY_SECRET (a current keya_ key)
 * so `vitest run` stays green offline.
 *
 * The suite reads, waits and refuses; it never delivers mail. Sending is
 * exercised only through requests the service refuses before anything is
 * queued, and the one write — marking a message read or unread — sets the
 * message to the state it already has. That write still emits a mail.read
 * event, which anyone watching the mailbox sees.
 */

import { expect } from "vitest";
import {
  BudClient,
  type BudError,
  Folder,
  Kind,
  type Me,
  Prefix,
  type Summary,
  into,
} from "../../src/bud/index.js";

export const BUD_PROD_BASE_URL = "https://bud.noetive.io";

/** Bounds each call so one slow request cannot stall the suite. */
export const BUD_REQUEST_TIMEOUT_MS = 30_000;

export const hasBudKey = (): boolean => (process.env.NOETIVE_KEY_SECRET ?? "").trim() !== "";

export function budKey(): string {
  const k = (process.env.NOETIVE_KEY_SECRET ?? "").trim();
  if (!k) throw new Error("NOETIVE_KEY_SECRET not set");
  return k;
}

export function call(): { signal: AbortSignal } {
  return { signal: AbortSignal.timeout(BUD_REQUEST_TIMEOUT_MS) };
}

/**
 * A client whose key the service accepts, and who it is. A key the service
 * refuses fails here, once and by name, rather than as a refusal in the
 * middle of every test that follows.
 */
export async function setup(): Promise<{ c: BudClient; me: Me }> {
  const c = new BudClient({ apiKey: budKey(), baseUrl: BUD_PROD_BASE_URL });
  const out = await c.describeMe(call());
  if (out.error) {
    throw new Error(
      `the service refused NOETIVE_KEY_SECRET: ${out.error.message}\nBud needs a current Noetive key (keya_...); legacy keys are not accepted`,
    );
  }
  const me = into(out, Kind.Me);
  expect(me.mailbox?.startsWith(Prefix.Agent), `me.mailbox = ${me.mailbox}`).toBe(true);
  return { c, me };
}

/** Fails unless the call came back as a refusal with `code` and a request id to quote. */
export function refused(op: string, error: BudError | undefined, code: string): BudError {
  expect(error, `${op}: want a ${code} refusal, got an answer`).toBeDefined();
  const e = error as BudError;
  expect(e.code, `${op}: ${e.message}`).toBe(code);
  expect(e.requestId, `${op}: the refusal carries no request id to quote`).not.toBe("");
  return e;
}

/** Fails unless the call was answered. */
export function answered(op: string, error: BudError | undefined): void {
  expect(error, `${op}: refused: ${error?.message}`).toBeUndefined();
}

/** One stored message, or undefined when the mailbox holds none. */
export async function anyMessage(c: BudClient, me: Me): Promise<Summary | undefined> {
  for (const folder of [Folder.Inbox, Folder.Sent]) {
    const out = await c.listFolder({ in: me.mailbox as string, folder, limit: 20 }, call());
    answered(`listFolder ${folder}`, out.error);
    const first = into(out, Kind.Folder).messages?.[0];
    if (first) return first;
  }
  return undefined;
}

/** A message's current summary. */
export async function findMessage(c: BudClient, me: Me, id: string): Promise<Summary> {
  for (const folder of [Folder.Inbox, Folder.Sent]) {
    let cursor = "";
    for (let page = 0; page < 20; page++) {
      const out = await c.listFolder(
        { in: me.mailbox as string, folder, limit: 200, cursor },
        call(),
      );
      answered(`listFolder ${folder}`, out.error);
      const found = into(out, Kind.Folder).messages?.find((s) => s.message === id);
      if (found) return found;
      cursor = out.cursor ?? "";
      if (!cursor) break;
    }
  }
  throw new Error(`message ${id} is no longer listed`);
}
