// A raw client for the conformance tests: it sends exactly what a test says and keeps every
// message it receives, so that a test can count answers, check order and look for silence.
import { connect, dropConnection, type Connection } from "@agent-space-protocol/sdk/transport";
import { generateKey, makeProof, type KeyPair } from "@agent-space-protocol/sdk/identity";
import { SDK_PARTS } from "@agent-space-protocol/sdk/types";

const INTERMEDIATE = new Set(["accepted", "progress", "waiting", "frame"]);
let counter = 0;

export class TimeoutError extends Error {}

export class Client {
  readonly messages: Record<string, any>[] = [];
  hello?: Record<string, any>;
  joined?: Record<string, any>;
  key?: KeyPair;
  closed = false;
  #conn: Connection;
  #waiters: { pred: (m: Record<string, any>) => boolean; resolve: (m: Record<string, any>) => void }[] = [];
  #closeWaiters: (() => void)[] = [];

  private constructor(conn: Connection) {
    this.#conn = conn;
    conn.onmessage = (text) => {
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(text);
      } catch {
        msg = { type: "x.inspector.unparsable", text };
      }
      this.messages.push(msg);
      this.#waiters = this.#waiters.filter((w) => {
        if (!w.pred(msg)) return true;
        w.resolve(msg);
        return false;
      });
    };
    conn.onclose = () => {
      this.closed = true;
      for (const w of this.#closeWaiters) w();
    };
  }

  static async open(address: string): Promise<Client> {
    return new Client(await connect(address, { stderr: "ignore" }));
  }

  /** A new request ID, unique for this run. */
  static id(prefix: string): string {
    return `${prefix}-${process.pid}-${Date.now().toString(36)}-${++counter}`;
  }

  send(message: Record<string, unknown>): void {
    this.#conn.send(message);
  }
  sendRaw(text: string): void {
    this.#conn.sendRaw(text);
  }

  /** Waits for the next message (from now, or already received when `past` is set) that matches. */
  waitFor(pred: (m: Record<string, any>) => boolean, timeoutMs = 10000, past = false): Promise<Record<string, any>> {
    if (past) {
      const found = this.messages.find(pred);
      if (found) return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.#waiters.push(w);
      setTimeout(() => {
        this.#waiters = this.#waiters.filter((x) => x !== w);
        reject(new TimeoutError(`no answer in ${timeoutMs / 1000} s`));
      }, timeoutMs);
    });
  }

  /** Waits until the connection closes. */
  waitClosed(timeoutMs = 15000): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.#closeWaiters.push(resolve);
      setTimeout(() => reject(new TimeoutError(`the connection did not close in ${timeoutMs / 1000} s`)), timeoutMs);
    });
  }

  /** Every message with this ID. */
  answers(id: string): Record<string, any>[] {
    return this.messages.filter((m) => m.id === id || (m.type === "frame" && m.stream === id));
  }

  /** The final answers for this ID received so far. */
  finals(id: string): Record<string, any>[] {
    return this.answers(id).filter((m) => !INTERMEDIATE.has(m.type));
  }

  /** Sends a request and waits for its final answer. */
  async request(message: Record<string, unknown>, timeoutMs = 10000): Promise<Record<string, any>> {
    const id = (message.id as string) ?? Client.id(String(message.type));
    const before = this.finals(id).length;
    this.send({ ...message, id });
    if (this.finals(id).length > before) return this.finals(id)[before];
    return this.waitFor((m) => m.id === id && !INTERMEDIATE.has(m.type), timeoutMs);
  }

  /** Shakes hands. */
  async handshake(options: { parts?: Record<string, number[]>; key?: KeyPair | boolean; extra?: Record<string, unknown> } = {}): Promise<Record<string, any>> {
    if (options.key) this.key = options.key === true ? generateKey() : options.key;
    this.send({
      type: "hello",
      parts: options.parts ?? SDK_PARTS,
      ...(this.key ? { participant: this.key.identity } : {}),
      client: { name: "agent-space check" },
      ...(options.extra ?? {}),
    });
    const hello = await this.waitFor((m) => m.type === "hello" || m.type === "error");
    if (hello.type === "error") throw new Error(`the handshake was refused: ${hello.code} ${hello.text ?? ""}`);
    this.hello = hello;
    return hello;
  }

  /** Joins; throws when refused. */
  async join(fields: Record<string, unknown> = {}): Promise<Record<string, any>> {
    const proof = this.key && this.hello ? { proof: makeProof(this.key, this.hello.space, this.hello.nonce) } : {};
    const out = await this.request({ type: "join", ...proof, ...fields });
    if (out.end !== "done") throw new Error(`join was ${out.end}: ${out.reason?.code} ${out.reason?.text ?? ""}`);
    this.joined = out.result;
    return out.result;
  }

  /** Waits a while and returns what arrived meanwhile. */
  async quiet(ms: number): Promise<Record<string, any>[]> {
    const start = this.messages.length;
    await new Promise((r) => setTimeout(r, ms));
    return this.messages.slice(start);
  }

  drop(): void {
    dropConnection(this.#conn);
  }
  close(): void {
    this.#conn.close();
  }
}
