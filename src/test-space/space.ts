// The test space, written with the TypeScript SDK's space skeleton. The laws here are the
// implementer's part; the skeleton keeps the protocol. `halfCommit` breaks atomicity on purpose.
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Space, SqliteStore, MemoryStore, Refused, type ActionContext, type EditContext } from "@agent-space-protocol/sdk/space";
import type { KeyPair } from "@agent-space-protocol/sdk/identity";
import type { Change, JSONValue, Structure, Thing, Relation } from "@agent-space-protocol/sdk/types";
import { capabilities, profile, vocabulary } from "./vocabulary.ts";

interface State {
  things: Record<string, Thing>;
  relations: Relation[];
  episode: number;
}

function initialState(): State {
  return {
    things: {
      "lamp:1": { id: "lamp:1", type: "test.lamp", on: false },
      "counter:1": { id: "counter:1", type: "test.counter", value: 0 },
      "box:1": { id: "box:1", type: "test.box", capacity: 2 },
      "ball:1": { id: "ball:1", type: "test.ball" },
      "ball:2": { id: "ball:2", type: "test.ball" },
      "ball:3": { id: "ball:3", type: "test.ball" },
      "safe:1": { id: "safe:1", type: "test.safe", code: "4721" },
      "door:east": { id: "door:east", type: "test.door" },
    },
    relations: [{ rel: "test.in", from: "ball:1", to: "box:1" }],
    episode: 0,
  };
}

export interface TestSpaceOptions {
  /** Keeps the record and the state in this folder, so they survive a restart. */
  data?: string;
  keepSeconds?: number | null;
  grace?: number;
  key?: KeyPair;
  doorTo?: string;
  doorSpace?: string;
  /** Broken on purpose: a change that breaks a constraint keeps its first half. */
  halfCommit?: boolean;
  stopGraceMs?: number;
}

/** Checks the constraints of a state; returns the broken one. */
function broken(state: State): { constraint: string; text: string } | undefined {
  const seen = new Set<string>();
  for (const r of state.relations) {
    if (r.rel !== "test.in") continue;
    if (seen.has(r.from)) return { constraint: "test.one_place", text: `${r.from} would be in two boxes` };
    seen.add(r.from);
  }
  for (const t of Object.values(state.things)) {
    if (t.type !== "test.box") continue;
    const n = state.relations.filter((r) => r.rel === "test.in" && r.to === t.id).length;
    if (n > Number(t.capacity)) return { constraint: "test.capacity", text: `${t.id} would hold ${n} balls, more than its capacity ${t.capacity}` };
  }
  return undefined;
}

export function createTestSpace(options: TestSpaceOptions = {}): Space {
  const statePath = options.data ? join(options.data, "state.json") : undefined;
  if (options.data) mkdirSync(options.data, { recursive: true });
  let state: State = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : initialState();
  const save = () => {
    if (!statePath) return;
    writeFileSync(statePath + ".tmp", JSON.stringify(state));
    renameSync(statePath + ".tmp", statePath);
  };
  const copy = (): State => JSON.parse(JSON.stringify(state));
  const thing = (id: string | undefined) => {
    const t = id ? state.things[id] : undefined;
    if (!t) throw new Refused("test.no_such_thing", `there is no ${id}`);
    return t;
  };

  const space: Space = new Space({
    key: options.key,
    capabilities: capabilities({ doorTo: options.doorTo ?? "ws://127.0.0.1:1/nowhere", doorSpace: options.doorSpace, grace: options.grace ?? 30 }),
    vocabulary,
    store: options.data ? new SqliteStore(join(options.data, "record.db")) : new MemoryStore(),
    keepSeconds: options.keepSeconds ?? null,
    server: { name: "agent-space test-space", version: "0.0.0" },
    hello: { "inspector.profile": profile },
    stopGraceMs: options.stopGraceMs ?? 1500,
    handlers: {
      observe: ({ forms }) => {
        const structure: Structure = { things: Object.values(state.things), relations: state.relations };
        const out: { structure: Structure; forms?: Record<string, { media: string; data: string }> } = { structure };
        if (forms.includes("text")) {
          const lamp = state.things["lamp:1"];
          const inBox = state.relations.filter((r) => r.to === "box:1").map((r) => r.from);
          out.forms = {
            text: {
              media: "text/plain",
              data: `A lamp, ${lamp?.on ? "on" : "off"}. A counter at ${state.things["counter:1"]?.value}. A box holding ${inBox.join(", ") || "nothing"}. A safe. A door to the east.`,
            },
          };
        }
        return out;
      },
      touches: (action) => (action.verb === "test.pack" ? ((action.args?.balls as string[]) ?? []) : []),
      verbs: {
        "test.toggle": (ctx: ActionContext) => {
          const lamp = thing(ctx.object);
          if (lamp.type !== "test.lamp") throw new Refused("malformed", `${ctx.object} is not a lamp`);
          lamp.on = !lamp.on;
          save();
          ctx.emit("test.switched", { on: lamp.on as boolean }, { things: [lamp.id] });
          return { result: { on: lamp.on as boolean } };
        },
        "test.add": (ctx: ActionContext) => {
          const counter = thing(ctx.object);
          counter.value = Number(counter.value) + Number(ctx.args.n);
          save();
          ctx.emit("test.added", { value: counter.value as number }, { things: [counter.id] });
          return { result: { value: counter.value as number } };
        },
        "test.wait": async (ctx: ActionContext) => {
          const ms = Number(ctx.args.seconds) * 1000;
          const step = 250;
          for (let t = 0; t < ms; t += step) {
            await ctx.sleep(Math.min(step, ms - t));
            ctx.progress(Math.min(1, (t + step) / ms), `waited ${Math.min(ms, t + step) / 1000} of ${ms / 1000} s`);
          }
          return { result: { waited: Number(ctx.args.seconds) } };
        },
        "test.pack": (ctx: ActionContext) => {
          const box = thing(ctx.object);
          const balls = ctx.args.balls as string[];
          for (const b of balls) if (thing(b).type !== "test.ball") throw new Refused("malformed", `${b} is not a ball`);
          if (options.halfCommit) {
            // Broken on purpose: changes the state ball by ball and stops at the first broken constraint.
            for (const b of balls) {
              state.relations = state.relations.filter((r) => !(r.rel === "test.in" && r.from === b));
              state.relations.push({ rel: "test.in", from: b, to: box.id });
              const bad = broken(state);
              if (bad) {
                state.relations.pop();
                save();
                throw new Refused("constraint", bad.text, { constraint: bad.constraint });
              }
            }
          } else {
            const next = copy();
            for (const b of balls) {
              next.relations = next.relations.filter((r) => !(r.rel === "test.in" && r.from === b));
              next.relations.push({ rel: "test.in", from: b, to: box.id });
            }
            const bad = broken(next);
            if (bad) throw new Refused("constraint", bad.text, { constraint: bad.constraint });
            state = next;
          }
          save();
          ctx.emit("test.packed", { box: box.id, balls }, { things: [box.id, ...balls] });
          return { result: { box: box.id, balls } };
        },
        "test.launch": (ctx: ActionContext) => {
          ctx.emit("test.launched", { by: ctx.presence.id });
          return { result: { launched: true } };
        },
        "test.paint": (ctx: ActionContext) => {
          const t = thing(ctx.object);
          t.color = String(ctx.args.color);
          save();
          ctx.emit("test.painted", { color: t.color as string }, { things: [t.id] });
          return { result: { color: t.color as string } };
        },
      },
      edit: (ctx: EditContext) => {
        const next = copy();
        const changed = new Set<string>();
        for (const c of ctx.changes ?? []) applyChange(next, c, changed);
        const bad = broken(next);
        if (bad) throw new Refused("constraint", bad.text, { constraint: bad.constraint });
        state = next;
        save();
        ctx.emit("test.changed", { changes: ctx.changes as unknown as JSONValue }, { things: [...changed] });
        return { things: [...changed], result: { changed: [...changed] } };
      },
      presentation: (p) => Object.fromEntries(Object.keys(p).map((k) => [k, k === "name" ? "used" : "ignored"])),
      episode: () => {
        state = { ...initialState(), episode: state.episode + 1 };
        save();
        return { episode: `e${state.episode}`, task: "light" };
      },
      score: () => ({ episode: `e${state.episode}`, score: state.things["lamp:1"]?.on ? 1 : 0 }),
      snapshot: () => state as unknown as JSONValue,
      restore: (s) => {
        state = s as unknown as State;
        save();
      },
      sense: (language, query, structure) => {
        if (language !== "test.path") return null;
        const [id, prop] = query.split(".");
        const t = structure.things.find((x) => x.id === id);
        return t ? ((prop ? t[prop] : t) as JSONValue) ?? null : null;
      },
      views: () => [{ name: "test", line: "A one-page view of the test space.", media: "text/html", bundle: viewHash }],
      take: ({ thing: t, as }) => {
        const id = `${t.id}@here`;
        state.things[id] = { ...t, id, type: as };
        delete (state.things[id] as Record<string, unknown>).parents;
        save();
        return { thing: id };
      },
      stream: async (ctx) => {
        const interval = 1000 / Math.min(ctx.rate ?? 4, 20);
        let n = 0;
        while (!ctx.signal.aborted) {
          await ctx.sleep(interval);
          ctx.frame({ media: "text/plain", data: `tick ${n++}` });
        }
      },
    },
  });
  const viewHash = space.putBlob("<!doctype html><title>test space</title><p>The test space.</p>", "text/html");
  return space;
}

function applyChange(state: State, c: Change, changed: Set<string>): void {
  switch (c.op) {
    case "add":
      if (state.things[c.thing.id]) throw new Refused("constraint", `${c.thing.id} already exists`, { constraint: "test.unique" });
      if (!vocabulary.types?.[c.thing.type]) throw new Refused("malformed", `no type ${c.thing.type}`);
      state.things[c.thing.id] = c.thing;
      changed.add(c.thing.id);
      return;
    case "set": {
      const t = state.things[c.thing];
      if (!t) throw new Refused("test.no_such_thing", `there is no ${c.thing}`);
      if (c.property === "id" || c.property === "type") throw new Refused("malformed", `${c.property} cannot be set`);
      t[c.property] = c.value;
      changed.add(c.thing);
      return;
    }
    case "remove":
      if (!state.things[c.thing]) throw new Refused("test.no_such_thing", `there is no ${c.thing}`);
      delete state.things[c.thing];
      state.relations = state.relations.filter((r) => r.from !== c.thing && r.to !== c.thing);
      changed.add(c.thing);
      return;
    case "relate":
      if (!state.things[c.relation.from] || !state.things[c.relation.to]) throw new Refused("test.no_such_thing", "both ends must exist");
      state.relations.push(c.relation);
      changed.add(c.relation.from).add(c.relation.to);
      return;
    case "unrelate":
      state.relations = state.relations.filter((r) => !(r.rel === c.relation.rel && r.from === c.relation.from && r.to === c.relation.to));
      changed.add(c.relation.from).add(c.relation.to);
      return;
  }
}
