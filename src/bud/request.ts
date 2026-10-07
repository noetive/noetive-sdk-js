/**
 * Requests as they go on the wire.
 *
 * The server's contract marks most request fields omitempty: a zero value — an
 * empty string, a 0, false, an empty list — is left out rather than sent, so a
 * caller's `cursor: ""` means what it means to the server, which is "no
 * cursor". A few fields are always present because the server's own document
 * always carries them (`id`, `in`, `changes`, `WaitInput.mailbox`,
 * `SendInput.to`), and `agent_part` is sent whenever it is set, false
 * included, because false is a filter rather than a default.
 */

import { BudErrorCodes, preflight } from "./error.js";

interface WireShape {
  /** Always encoded; the value stands in when the caller left the field out. */
  always: Record<string, unknown>;
  /** Encoded whenever set, zero values included. */
  whenSet?: readonly string[];
}

const ID: WireShape = { always: { id: "" } };
const IN: WireShape = { always: { in: "" } };

const SHAPES: Record<string, WireShape> = {
  "folder.list": IN,
  "correspondent.list": IN,
  "message.describe": ID,
  "thread.describe": ID,
  "part.describe": ID,
  "mailbox.describe": ID,
  "message.update": { always: { id: "", changes: undefined } },
  send: { always: { to: [] } },
  watch: { always: { mailbox: "" }, whenSet: ["agent_part"] },
};

/** The JSON body for `op`. A body that cannot be encoded is refused before sending. */
export function wireBody(op: string, input: object): string {
  try {
    return JSON.stringify(wireObject(op, input));
  } catch (cause) {
    throw preflight(
      BudErrorCodes.Invalid,
      `the request could not be encoded: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/** The object `wireBody` encodes; exposed for the contract check. */
export function wireObject(op: string, input: object): Record<string, unknown> {
  const shape = SHAPES[op] ?? { always: {} };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key in shape.always) continue;
    if (shape.whenSet?.includes(key)) {
      if (value !== undefined && value !== null) out[key] = value;
      continue;
    }
    if (!isZero(value)) out[key] = value;
  }
  for (const [key, fallback] of Object.entries(shape.always)) {
    out[key] = (input as Record<string, unknown>)[key] ?? fallback;
  }
  return out;
}

function isZero(v: unknown): boolean {
  return (
    v === undefined ||
    v === null ||
    v === "" ||
    v === 0 ||
    v === false ||
    (Array.isArray(v) && v.length === 0)
  );
}
