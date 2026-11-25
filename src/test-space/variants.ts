// Deliberately broken variants of the test space. Each breaks one guarantee, so that the
// conformance test for that guarantee, and only that one, catches it. Most work by changing the
// messages between the space skeleton and the connection; `half-commit` breaks the test space's
// own law instead (see space.ts).
import { MESSAGE_CAPABILITY } from "@agent-space-protocol/sdk/types";
import type { Connection } from "@agent-space-protocol/sdk/transport";

export const VARIANTS = ["drop-outcome", "run-twice", "half-commit", "drop-on-resume", "silent-unsupported"] as const;
export type Variant = (typeof VARIANTS)[number];

/** Which test is meant to catch each variant. */
export const CAUGHT_BY: Record<Variant, string> = {
  "drop-outcome": "outcome.cancel",
  "run-twice": "idempotency.repeat",
  "half-commit": "atomic.constraint",
  "drop-on-resume": "record.resume",
  "silent-unsupported": "unsupported.all",
};

/** Shared across connections, as a broken space would be. */
const seen = new Map<string, number>();

/** Wraps a connection so that the space behind it is broken in the given way. */
export function breakConnection(conn: Connection, variant: Variant | undefined, head: () => number): Connection {
  if (!variant || variant === "half-commit") return conn;
  let participant = "";
  let parts: Record<string, number> = {};
  const cancelled = new Set<string>();
  const renamed = new Map<string, string>();
  let dropNextFrom: number | undefined;

  const wrapped: Connection = {
    get closed() {
      return conn.closed;
    },
    get peer() {
      return conn.peer;
    },
    sendRaw: (text) => conn.sendRaw(text),
    close: () => conn.close(),
    send(message: Record<string, any>) {
      if (message.type === "hello" && message.parts) parts = message.parts;
      if (variant === "drop-outcome" && message.type === "outcome" && cancelled.has(message.id)) return;
      if (variant === "run-twice" && message.id && renamed.has(message.id)) message = { ...message, id: renamed.get(message.id) };
      if (variant === "drop-on-resume" && message.type === "event" && dropNextFrom !== undefined && message.entry.seq >= dropNextFrom) {
        dropNextFrom = undefined;
        return;
      }
      conn.send(message);
    },
  };
  conn.onclose = () => wrapped.onclose?.();
  conn.onmessage = (text) => {
    let msg: Record<string, any> | undefined;
    try {
      msg = JSON.parse(text);
    } catch {
      /* passed on as it is */
    }
    if (msg && typeof msg === "object") {
      if (msg.type === "hello") participant = msg.participant ?? msg.token ?? "";
      if (variant === "drop-outcome" && msg.type === "cancel") cancelled.add(msg.action);
      if (variant === "run-twice" && msg.type === "act" && typeof msg.id === "string") {
        const key = `${participant}\n${msg.id}`;
        const n = (seen.get(key) ?? 0) + 1;
        seen.set(key, n);
        if (n > 1) {
          const fresh = `${msg.id}~${n}`;
          renamed.set(fresh, msg.id);
          text = JSON.stringify({ ...msg, id: fresh });
        }
      }
      if (variant === "drop-on-resume" && msg.type === "subscribe" && typeof msg.from === "number" && msg.from <= head()) dropNextFrom = msg.from;
      if (variant === "silent-unsupported") {
        const part = MESSAGE_CAPABILITY[msg.type];
        if (part && part !== "edit" && parts[part] === undefined) return;
      }
    }
    wrapped.onmessage?.(text);
  };
  return wrapped;
}
