// `agent-space tui`: a terminal client for any space. It shows the space as things, relations and a
// stream of events, keeps every action with its intermediate states and final outcome, and lets
// you enter, observe, act, edit and cancel. It uses structure only, so every space can be used with it.
import { createInterface, type Interface } from "node:readline";
import { readFileSync } from "node:fs";
import { Participant } from "@agent-space-protocol/sdk/participant";
import { generateKey, loadOrCreateKey } from "@agent-space-protocol/sdk/identity";
import type { Change, Entry, Outcome, Relation, Thing, Vocabulary } from "@agent-space-protocol/sdk/types";
import { BASE, EVENT, OUTCOME, STATE, paint, type Token } from "./tokens.ts";

export interface TuiOptions {
  address: string;
  role?: string;
  keyFile?: string;
  /** Run these commands, one a line, then print the screen and exit. */
  script?: string;
  /** No colours and no redrawing: print the screen after each command. */
  plain?: boolean;
  /** Milliseconds between scripted commands. */
  delayMs?: number;
}

interface ActionRow {
  id: string;
  label: string;
  state: string;
  detail: string;
  end?: string;
  time: number;
}

const HELP = [
  "observe                           look again",
  "act <verb> [object] [json args]   take an action, e.g. act test.toggle lamp:1",
  "edit set <thing> <prop> <json>    change a property (needs the right to edit)",
  "edit add <id> <type> | edit remove <id> | edit json <changes>",
  "cancel [id]                       ask to cancel an action (the last one under way by default)",
  "verbs                             the verbs of the vocabulary",
  "record [n]                        the last n entries of the record",
  "sleep <seconds>                   wait (for scripts)",
  "help | quit",
];

export async function runTui(options: TuiOptions): Promise<void> {
  const tui = new Tui(options);
  await tui.start();
}

class Tui {
  #o: TuiOptions;
  #p!: Participant;
  #vocab?: Vocabulary;
  #things: Thing[] = [];
  #relations: Relation[] = [];
  #seq = 0;
  #events: Entry[] = [];
  #actions = new Map<string, ActionRow>();
  #messages: string[] = [];
  #rl?: Interface;
  #mode: "none" | "basic" | "true";
  #observeTimer?: NodeJS.Timeout;
  #status = "connecting";

  constructor(options: TuiOptions) {
    this.#o = options;
    this.#mode = options.plain || !process.stdout.isTTY ? "none" : process.env.COLORTERM?.includes("truecolor") || process.env.WT_SESSION ? "true" : "basic";
  }

  async start(): Promise<void> {
    const key = this.#o.keyFile ? loadOrCreateKey(this.#o.keyFile) : generateKey();
    this.#p = await Participant.connect(this.#o.address, { key, client: { name: "agent-space tui" } });
    this.#status = "connected";
    this.#p.on("disconnect", () => ((this.#status = "reconnecting"), this.#render()));
    this.#p.on("reconnect", () => ((this.#status = "connected"), this.#render()));
    this.#p.on("closing", () => ((this.#status = "closing"), this.#render()));
    this.#p.on("event", (e) => {
      this.#events.push(e);
      if (this.#events.length > 500) this.#events.shift();
      if (!e.type.startsWith("asp.") || e.type === "asp.take" || e.type === "asp.restore") this.#observeSoon();
      else if (e.type === "asp.outcome" && (e.data as Record<string, unknown>)?.id !== undefined) this.#observeSoon();
      this.#render();
    });
    const joined = await this.#p.join(this.#o.role ? { role: this.#o.role } : {});
    this.#say(`entered as ${joined.role}, presence ${joined.presence}`);
    this.#vocab = await this.#p.vocabulary();
    await this.#p.subscribe({ from: Math.max(joined.head - 20, this.#p.hello.record.earliest, 1) });
    await this.#observe();
    if (this.#o.script) return this.#runScript(this.#o.script);
    this.#interactive();
  }

  #say(text: string): void {
    this.#messages.push(text);
    if (this.#messages.length > 4) this.#messages.shift();
  }

  #observeSoon(): void {
    clearTimeout(this.#observeTimer);
    this.#observeTimer = setTimeout(() => void this.#observe(), 80);
  }

  async #observe(): Promise<void> {
    try {
      const o = await this.#p.observe();
      this.#things = o.structure.things;
      this.#relations = o.structure.relations ?? [];
      this.#seq = o.seq;
      this.#render();
    } catch (e) {
      this.#say(`observe: ${(e as Error).message}`);
    }
  }

  async #runScript(path: string): Promise<void> {
    const lines = readFileSync(path, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    for (const line of lines) {
      if (this.#o.plain) process.stdout.write(`\n> ${line}\n`);
      await this.#command(line);
      await new Promise((r) => setTimeout(r, this.#o.delayMs ?? 300));
      if (this.#o.plain) process.stdout.write(this.#frame() + "\n");
    }
    this.#p.close();
    if (!this.#o.plain) process.stdout.write("\n");
    process.exit(0);
  }

  #interactive(): void {
    this.#rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "› " });
    this.#rl.on("line", async (line) => {
      if (line.trim() === "quit" || line.trim() === "exit") {
        this.#p.close();
        process.stdout.write("\x1b[?1049l");
        process.exit(0);
      }
      await this.#command(line.trim());
      this.#render();
    });
    this.#rl.on("close", () => {
      this.#p.close();
      process.stdout.write("\x1b[?1049l");
      process.exit(0);
    });
    process.stdout.on("resize", () => this.#render());
    if (this.#mode !== "none") process.stdout.write("\x1b[?1049h");
    this.#render();
  }

  async #command(line: string): Promise<void> {
    const [cmd, ...rest] = line.split(/\s+/);
    try {
      switch (cmd) {
        case "":
          return;
        case "help":
          for (const h of HELP) this.#say(h);
          return;
        case "observe":
          return this.#observe();
        case "verbs":
          this.#say(Object.entries(this.#vocab?.verbs ?? {}).map(([v, d]) => `${v}${d.object ? ` <${d.object}>` : ""}`).join("  "));
          return;
        case "sleep":
          await new Promise((r) => setTimeout(r, Number(rest[0] ?? 1) * 1000));
          return;
        case "record": {
          const n = Number(rest[0] ?? 10);
          const r = await this.#p.record({ from: Math.max(this.#p.hello.record.earliest, this.#seq - n + 1) });
          for (const e of r.entries.slice(-4)) this.#say(`${e.seq} ${e.type} ${short(e.data)}`);
          return;
        }
        case "act": {
          const [verb, maybeObject, ...json] = rest;
          if (!verb) return this.#say("act needs a verb");
          let object: string | undefined = maybeObject;
          let argsText = json.join(" ");
          if (maybeObject?.startsWith("{")) {
            object = undefined;
            argsText = [maybeObject, ...json].join(" ");
          }
          const args = argsText ? JSON.parse(argsText) : undefined;
          const pending = this.#p.act({ verb, ...(object ? { object } : {}), ...(args ? { args } : {}), basis: this.#seq || undefined });
          this.#track(pending.id, `${verb}${object ? ` ${object}` : ""}${args ? ` ${short(args)}` : ""}`, pending);
          return;
        }
        case "edit": {
          const [op, a, b, ...json] = rest;
          let changes: Change[];
          if (op === "set") changes = [{ op: "set", thing: a, property: b, value: JSON.parse(json.join(" ")) }];
          else if (op === "add") changes = [{ op: "add", thing: { id: a, type: b } }];
          else if (op === "remove") changes = [{ op: "remove", thing: a }];
          else if (op === "json") changes = JSON.parse([a, b, ...json].join(" "));
          else return this.#say("edit set|add|remove|json …");
          const pending = this.#p.edit({ changes });
          this.#track(pending.id, `edit ${rest.join(" ")}`, pending);
          return;
        }
        case "cancel": {
          const id = rest[0] ?? [...this.#actions.values()].reverse().find((a) => !a.end)?.id;
          if (!id) return this.#say("nothing under way to cancel");
          this.#p.cancel(id);
          const row = this.#actions.get(id);
          if (row && !row.end) row.detail = `cancel asked · ${row.detail}`;
          this.#say(`asked to cancel ${id}`);
          return;
        }
        default:
          this.#say(`unknown command ${cmd}; type help`);
      }
    } catch (e) {
      this.#say(`${cmd}: ${(e as Error).message}`);
    }
  }

  #track(id: string, label: string, pending: { onUpdate(fn: (u: Record<string, unknown>) => void): unknown; done: Promise<Outcome> }): void {
    const row: ActionRow = { id, label, state: "sent", detail: "", time: Date.now() };
    this.#actions.set(id, row);
    pending.onUpdate((u) => {
      row.state = String(u.type);
      if (u.type === "progress") row.detail = `${u.progress !== undefined ? `${Math.round(Number(u.progress) * 100)}%` : ""}${u.text ? ` ${u.text}` : ""}`.trim();
      if (u.type === "waiting") row.detail = `for ${(u.for as { role: string }).role} until ${String(u.until).slice(11, 19)}`;
      this.#render();
    });
    void pending.done.then((out) => {
      row.end = out.end;
      row.state = out.end;
      row.detail = [out.reason ? `${out.reason.code}${out.reason.text ? `: ${out.reason.text}` : ""}` : "", out.result !== undefined ? short(out.result) : "", out.seq !== undefined ? `@${out.seq}` : ""]
        .filter(Boolean)
        .join("  ");
      this.#render();
    });
    this.#render();
  }

  #paint(text: string, token?: { hex: string; ansi: number }): string {
    return paint(text, token, this.#mode);
  }

  #frame(): string {
    const width = Math.max(72, Math.min(process.stdout.columns || 110, 160));
    const height = this.#o.plain ? 0 : process.stdout.rows || 40;
    const line = this.#paint("─".repeat(width), BASE.line);
    const head = this.#p.hello;
    const presence = this.#p.presence;
    const out: string[] = [];
    out.push(
      `${this.#paint("AGENT SPACE", BASE.accent)}  ${head.space.length > 28 ? head.space.slice(0, 27) + "…" : head.space}  ·  ${presence ? `${presence.presence} as ${presence.role}` : "not entered"}  ·  seq ${this.#seq}  ·  ${this.#status}`,
    );
    out.push(line);
    const left = Math.floor(width * 0.48);
    const right = width - left - 3;
    const things = this.#thingLines(left);
    const events = this.#eventLines(right);
    const bodyRows = height ? Math.max(6, height - 16) : Math.max(things.length, Math.min(events.length, 14));
    out.push(`${this.#paint(pad("THINGS", left), BASE.muted)} ${this.#paint("│", BASE.line)} ${this.#paint("EVENTS", BASE.muted)}`);
    const ev = events.slice(-bodyRows);
    for (let i = 0; i < bodyRows; i++) out.push(`${padAnsi(things[i] ?? "", left)} ${this.#paint("│", BASE.line)} ${ev[i] ?? ""}`);
    out.push(line);
    out.push(this.#paint("ACTIONS", BASE.muted));
    const rows = [...this.#actions.values()].slice(-6);
    if (!rows.length) out.push(this.#paint("  none yet: act <verb> [object] [args]", BASE.line));
    for (const a of rows) out.push(this.#actionLine(a, width));
    out.push(line);
    for (const m of this.#messages) out.push(`  ${m}`);
    return out.join("\n");
  }

  #thingLines(width: number): string[] {
    const lines: string[] = [];
    const inside = new Map<string, Relation[]>();
    const contained = new Set<string>();
    for (const r of this.#relations) {
      if (!inside.has(r.to)) inside.set(r.to, []);
      inside.get(r.to)!.push(r);
      contained.add(r.from);
    }
    const props = (t: Thing) =>
      Object.entries(t)
        .filter(([k]) => k !== "id" && k !== "type")
        .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
        .join(" ");
    const draw = (t: Thing, depth: number, via?: string) => {
      const prefix = depth ? `${"  ".repeat(depth - 1)}└ ` : "";
      const text = `${prefix}${t.id}  ${this.#paint(t.type, BASE.line)}${via ? this.#paint(` (${via})`, BASE.line) : ""}  ${props(t)}`;
      lines.push(truncAnsi(text, width));
      for (const r of inside.get(t.id) ?? []) {
        const child = this.#things.find((x) => x.id === r.from);
        if (child && depth < 4) draw(child, depth + 1, r.rel);
      }
    };
    for (const t of this.#things) if (!contained.has(t.id)) draw(t, 0);
    return lines;
  }

  #eventLines(width: number): string[] {
    return this.#events.map((e) => {
      const family = e.source.startsWith("outside") ? EVENT.outside : e.type.startsWith("asp.") ? EVENT.protocol : EVENT.space;
      const data = (e.data ?? {}) as Record<string, any>;
      let text: string;
      if (e.type === "asp.outcome") {
        const tok = OUTCOME[data.end] as Token | undefined;
        text = `${this.#paint(tok?.symbol ?? "·", tok)} ${data.id} ${this.#paint(data.end, tok)}${data.reason ? ` ${data.reason.code}` : ""}`;
      } else if (e.type === "asp.act") text = `${this.#paint("→", EVENT.protocol)} ${data.id} ${data.verb}${data.object ? ` ${data.object}` : ""}`;
      else if (e.type === "asp.edit") text = `${this.#paint("✎", EVENT.protocol)} ${data.id} edit`;
      else text = `${this.#paint(family.symbol, family)} ${e.type}${e.things?.length ? ` ${e.things.join(",")}` : ""} ${short(e.data, 40)}`;
      return truncAnsi(`${this.#paint(String(e.seq).padStart(5), BASE.line)} ${text}`, width);
    });
  }

  #actionLine(a: ActionRow, width: number): string {
    const tok = (OUTCOME[a.state] ?? STATE[a.state]) as Token | undefined;
    const label = `${a.id.split("-")[0]}  ${a.label}`;
    return truncAnsi(`  ${this.#paint(tok?.symbol ?? "·", tok)} ${pad(label, 40)} ${this.#paint(pad(a.state, 10), tok)} ${a.detail}`, width);
  }

  #render(): void {
    if (this.#o.plain || this.#o.script) return;
    const frame = this.#frame();
    process.stdout.write("\x1b[H\x1b[2J" + frame + "\n");
    if (this.#rl) {
      const line = this.#rl.line;
      this.#rl.prompt(true);
      if (line) this.#rl.write(null, { ctrl: true, name: "e" });
    }
  }
}

function short(v: unknown, max = 60): string {
  if (v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

const ANSI = /\x1b\[[0-9;]*m/g;
function visible(s: string): number {
  return [...s.replace(ANSI, "")].length;
}
function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}
function padAnsi(s: string, n: number): string {
  const v = visible(s);
  return v >= n ? s : s + " ".repeat(n - v);
}
function truncAnsi(s: string, n: number): string {
  if (visible(s) <= n) return s;
  let out = "";
  let count = 0;
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1b[")) {
      out += part;
      continue;
    }
    for (const ch of part) {
      if (count >= n - 1) return out + (s.includes("\x1b[") ? "…\x1b[0m" : "…");
      out += ch;
      count++;
    }
  }
  return out;
}
