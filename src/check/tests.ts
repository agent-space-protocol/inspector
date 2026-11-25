// The conformance tests. Each derives what to do from the space's declarations and, where a
// concrete action is needed, from the profile. A test whose probe is missing is skipped.
import { readPass } from "@agent-space-protocol/sdk/identity";
import { MESSAGE_CAPABILITY } from "@agent-space-protocol/sdk/types";
import { isDeepStrictEqual } from "node:util";
import { Client } from "./client.ts";

export interface Probe {
  verb: string;
  object?: string;
  args?: Record<string, unknown>;
  property?: string;
}

export interface Profile {
  role?: string;
  owner?: string;
  done?: Probe;
  counter?: Probe & { property: string };
  slow?: Probe;
  stale?: Probe;
  constraint?: Probe | { changes: unknown[] };
  consent?: Probe;
  forbidden?: Probe & { role: string };
  offer?: { thing: Record<string, any>; unknown?: Record<string, any> };
}

export interface Launcher {
  /** Kills the space's process at once, without letting it close. */
  kill(): Promise<void>;
  /** Ends the space's standard input, so that it closes gracefully, and waits for it to exit. */
  closeGracefully(): Promise<void>;
  /** Starts it again and waits until it accepts connections. */
  start(): Promise<void>;
}

export interface Context {
  address: string;
  hello: Record<string, any>;
  profile: Profile;
  launcher?: Launcher;
  /** Whether every connection reaches the same space (false for a command address). */
  shared: boolean;
  /** A connected client that has shaken hands. */
  client(options?: { key?: boolean | import("@agent-space-protocol/sdk/identity").KeyPair; parts?: Record<string, number[]> }): Promise<Client>;
  /** A client that has joined, as the profile's role by default. */
  joined(role?: string, options?: { key?: boolean | import("@agent-space-protocol/sdk/identity").KeyPair }): Promise<Client>;
}

export class Skip extends Error {}

export interface Verdict {
  status: "pass" | "fail" | "skip";
  notes: string[];
}

/** Collects what a test found. */
export class Findings {
  failures: string[] = [];
  notes: string[] = [];
  expect(cond: unknown, failure: string): boolean {
    if (!cond) this.failures.push(failure);
    return Boolean(cond);
  }
  note(text: string): void {
    this.notes.push(text);
  }
}

export interface ConformanceTest {
  id: string;
  what: string;
  /** Run only with a launcher; run after the others. */
  launch?: boolean;
  /** Needs several connections to the same space. */
  shared?: boolean;
  run(ctx: Context, f: Findings): Promise<void>;
}

const SLOW_DEADLINE = 0.5;

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Skip(`no ${what} in the profile`);
  return value;
}

function act(probe: Probe, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "act", verb: probe.verb, ...(probe.object ? { object: probe.object } : {}), ...(probe.args ? { args: probe.args } : {}), ...extra };
}

/** Checks that an ID got exactly one final answer, and no more within a quiet period. */
async function exactlyOne(c: Client, id: string, f: Findings, quietMs = 400): Promise<Record<string, any> | undefined> {
  await c.quiet(quietMs);
  const finals = c.finals(id);
  f.expect(finals.length === 1, `${id} got ${finals.length} final answers, not exactly one`);
  const after = c.answers(id).slice(c.answers(id).indexOf(finals[0]) + 1);
  f.expect(after.length === 0, `${id} got ${after.map((m) => m.type).join(", ")} after its final outcome`);
  return finals[0];
}

async function waitFinal(c: Client, id: string, timeoutMs: number): Promise<Record<string, any>> {
  return c.waitFor((m) => m.id === id && !["accepted", "progress", "waiting", "frame"].includes(m.type), timeoutMs, true);
}

function thingOf(observation: Record<string, any>, id: string): Record<string, any> | undefined {
  return observation.structure?.things?.find((t: Record<string, any>) => t.id === id);
}

function normalize(structure: Record<string, any>): unknown {
  const things = [...(structure.things ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const relations = [...(structure.relations ?? [])].map((r) => JSON.stringify(r)).sort();
  return { things, relations };
}

async function observe(c: Client): Promise<Record<string, any>> {
  const o = await c.request({ type: "observe" });
  if (o.type !== "observation") throw new Error(`observe was answered with ${o.type} ${o.reason?.code ?? ""}`);
  return o;
}

async function recordFrom(c: Client, from: number, tolerant = false): Promise<Record<string, any>[]> {
  const out: Record<string, any>[] = [];
  let next = Math.max(from, 1);
  for (;;) {
    const r = await c.request({ type: "record", from: next });
    if (tolerant && r.type === "outcome" && r.reason?.code === "expired" && typeof r.reason?.data?.earliest === "number" && r.reason.data.earliest > next) {
      next = r.reason.data.earliest;
      continue;
    }
    if (r.type !== "entries") throw new Error(`record was answered with ${r.type} ${r.reason?.code ?? ""}`);
    out.push(...r.entries);
    if (!r.more || !r.entries.length) return out;
    next = r.entries[r.entries.length - 1].seq + 1;
  }
}

function roles(hello: Record<string, any>): Record<string, any> {
  return hello.capabilities?.participants?.roles ?? { owner: { verbs: ["*"], edit: true, consent: true }, member: { verbs: ["*"] }, guest: { verbs: [] } };
}

export const TESTS: ConformanceTest[] = [
  {
    id: "handshake.errors",
    what: "A request before hello is malformed; a hello with no common core is unsupported",
    async run(ctx, f) {
      const a = await Client.open(ctx.address);
      a.send({ type: "observe", id: Client.id("early") });
      const e1 = await a.waitFor(() => true);
      f.expect(e1.type === "error" && e1.code === "malformed", `a request before hello got ${e1.type} ${e1.code ?? e1.reason?.code ?? ""}, not error malformed`);
      a.close();
      const b = await Client.open(ctx.address);
      b.send({ type: "hello", parts: { core: [9999] } });
      const e2 = await b.waitFor(() => true);
      f.expect(e2.type === "error" && e2.code === "unsupported", `a hello with no common core got ${e2.type} ${e2.code ?? ""}, not error unsupported`);
      b.close();
      const c = await Client.open(ctx.address);
      c.send({ type: "hello", parts: { "x.inspector.part": [1] } });
      const e3 = await c.waitFor(() => true);
      f.expect(e3.type === "error" && e3.code === "malformed", `a hello without core got ${e3.type} ${e3.code ?? ""}, not error malformed`);
      c.close();
    },
  },
  {
    id: "compat.parts",
    what: "Each part gets the highest common version; parts only one side knows are left out",
    async run(ctx, f) {
      const supported: Record<string, number[]> = ctx.hello.supported ?? { core: [ctx.hello.parts.core] };
      const offer: Record<string, number[]> = { "x.inspector.part": [1, 2] };
      for (const [part, versions] of Object.entries(supported)) offer[part] = [...versions, Math.max(...versions) + 7];
      const c = await ctx.client({ parts: offer });
      const parts = c.hello!.parts;
      for (const [part, versions] of Object.entries(supported)) {
        f.expect(parts[part] === Math.max(...versions), `part ${part} was negotiated as ${parts[part]}, not ${Math.max(...versions)}`);
      }
      f.expect(parts["x.inspector.part"] === undefined, "a part the space does not know was negotiated");
      c.close();
      const d = await ctx.client({ parts: { core: supported.core } });
      f.expect(Object.keys(d.hello!.parts).join() === "core", `offering only core negotiated ${Object.keys(d.hello!.parts).join(", ")}`);
      d.close();
    },
  },
  {
    id: "compat.unknown-fields",
    what: "Messages with unknown fields are handled as usual",
    async run(ctx, f) {
      const probe = need(ctx.profile.done, "done probe");
      const c = await Client.open(ctx.address);
      await c.handshake({ extra: { "x.inspector.note": { nested: true } } });
      await c.join({ role: ctx.profile.role, presentation: { name: "inspector", "x.inspector.mood": "curious" }, "x.inspector.note": 1 });
      const out = await c.request(act(probe, { "x.inspector.trace": "t-1", "x.inspector.deep": { a: [1, 2] } }));
      f.expect(out.type === "outcome" && out.end === "done", `an action with unknown fields was ${out.end} ${out.reason?.code ?? ""}`);
      const o = await c.request({ type: "observe", "x.inspector.note": "hi" });
      f.expect(o.type === "observation", `observe with an unknown field got ${o.type}`);
      c.close();
    },
  },
  {
    id: "outcome.done",
    what: "An action that is done gets exactly one done, recorded once",
    async run(ctx, f) {
      const probe = need(ctx.profile.done, "done probe");
      const c = await ctx.joined();
      const id = Client.id("done");
      c.send(act(probe, { id }));
      const out = await waitFinal(c, id, 10000);
      f.expect(out.end === "done", `the done probe was ${out.end} ${out.reason?.code ?? ""}`);
      await exactlyOne(c, id, f);
      if (out.seq !== undefined) {
        const entries = await recordFrom(c, c.joined!.head);
        const outcomes = entries.filter((e) => e.type === "asp.outcome" && e.data?.id === id);
        const acts = entries.filter((e) => e.type === "asp.act" && e.data?.id === id);
        f.expect(outcomes.length === 1, `the record holds ${outcomes.length} outcomes for ${id}`);
        f.expect(acts.length === 1, `the record holds ${acts.length} asp.act entries for ${id}`);
        if (outcomes[0] && acts[0]) f.expect(outcomes[0].cause === acts[0].seq, "the outcome's cause is not its asp.act entry");
        for (const ev of out.events ?? []) {
          const e = entries.find((x) => x.seq === ev);
          f.expect(e && e.cause === acts[0]?.seq, `event ${ev} does not name the action as its cause`);
        }
      } else f.expect(false, "the outcome has no seq: it was not recorded");
      c.close();
    },
  },
  {
    id: "outcome.forbidden",
    what: "A verb the role may not use is refused with forbidden",
    async run(ctx, f) {
      let probe = ctx.profile.forbidden;
      if (!probe) {
        const all = Object.entries(roles(ctx.hello));
        const verbs = Object.keys((await (await ctx.client()).request({ type: "vocabulary" })).vocabulary?.verbs ?? {});
        for (const [role, r] of all) {
          const missing = verbs.find((v) => !(r.verbs ?? []).includes("*") && !(r.verbs ?? []).includes(v));
          if (missing) {
            probe = { role, verb: missing };
            break;
          }
        }
      }
      if (!probe) throw new Skip("every role may use every verb");
      const c = await ctx.joined(probe.role);
      const id = Client.id("forbidden");
      c.send(act(probe, { id }));
      const out = await waitFinal(c, id, 10000);
      f.expect(out.end === "refused" && out.reason?.code === "forbidden", `${probe.verb} as ${probe.role} was ${out.end} ${out.reason?.code ?? ""}, not refused forbidden`);
      await exactlyOne(c, id, f);
      c.close();
    },
  },
  {
    id: "outcome.malformed",
    what: "Wrong arguments and broken messages are refused with malformed; unknown verbs with unsupported",
    async run(ctx, f) {
      const c = await ctx.joined();
      const vocabulary = (await c.request({ type: "vocabulary" })).vocabulary ?? {};
      const allowed: string[] = roles(ctx.hello)[c.joined!.role]?.verbs ?? ["*"];
      const withParams = Object.entries<any>(vocabulary.verbs ?? {}).find(
        ([v, d]) => d.params?.required?.length && (allowed.includes("*") || allowed.includes(v)),
      );
      if (withParams) {
        const id = Client.id("badargs");
        const [verb, decl] = withParams;
        const object = decl.object ? (ctx.profile.counter?.object ?? ctx.profile.done?.object ?? "x") : undefined;
        c.send({ type: "act", id, verb, ...(object ? { object } : {}), args: {} });
        const out = await waitFinal(c, id, 10000);
        f.expect(out.end === "refused" && out.reason?.code === "malformed", `${verb} without its required arguments was ${out.end} ${out.reason?.code ?? ""}`);
        await exactlyOne(c, id, f, 200);
      } else f.note("no verb with required parameters to try");
      const id2 = Client.id("noverb");
      c.send({ type: "act", id: id2 });
      const out2 = await waitFinal(c, id2, 10000);
      f.expect(out2.type === "outcome" && out2.end === "refused" && out2.reason?.code === "malformed", `an act without a verb got ${out2.type} ${out2.end ?? ""} ${out2.reason?.code ?? out2.code ?? ""}`);
      const id3 = Client.id("unknownverb");
      c.send({ type: "act", id: id3, verb: "x.inspector.nothing" });
      const out3 = await waitFinal(c, id3, 10000);
      f.expect(out3.end === "refused" && out3.reason?.code === "unsupported", `an unknown verb was ${out3.end} ${out3.reason?.code ?? ""}, not refused unsupported`);
      const id4 = Client.id("badobserve");
      c.send({ type: "observe", id: id4, forms: "structure" });
      const out4 = await waitFinal(c, id4, 10000);
      f.expect(out4.type === "outcome" && out4.reason?.code === "malformed", `a malformed observe got ${out4.type} ${out4.reason?.code ?? ""}`);
      c.close();
    },
  },
  {
    id: "outcome.deadline",
    what: "A slow action with a short deadline ends in exactly one failed or unknown with deadline",
    async run(ctx, f) {
      const probe = need(ctx.profile.slow, "slow probe");
      const c = await ctx.joined();
      const id = Client.id("deadline");
      c.send(act(probe, { id, deadline: SLOW_DEADLINE }));
      const out = await waitFinal(c, id, 15000);
      f.expect(["failed", "unknown"].includes(out.end) && out.reason?.code === "deadline", `past its deadline it was ${out.end} ${out.reason?.code ?? ""}`);
      await exactlyOne(c, id, f);
      c.close();
    },
  },
  {
    id: "outcome.cancel",
    what: "A cancelled action gets exactly one outcome",
    async run(ctx, f) {
      const probe = need(ctx.profile.slow, "slow probe");
      const c = await ctx.joined();
      const id = Client.id("cancel");
      c.send(act(probe, { id }));
      await c.waitFor((m) => m.id === id, 5000).catch(() => undefined);
      c.send({ type: "cancel", action: id });
      let out: Record<string, any> | undefined;
      try {
        out = await waitFinal(c, id, 10000);
      } catch {
        f.expect(false, `${id} got no final outcome after cancel`);
        c.close();
        return;
      }
      f.expect(["cancelled", "done", "unknown"].includes(out.end), `a cancelled action was ${out.end}`);
      await exactlyOne(c, id, f);
      c.close();
    },
  },
  {
    id: "outcome.cancel-after-done",
    what: "Cancelling after done brings no second outcome",
    async run(ctx, f) {
      const probe = need(ctx.profile.done, "done probe");
      const c = await ctx.joined();
      const id = Client.id("late");
      c.send(act(probe, { id }));
      const out = await waitFinal(c, id, 10000);
      c.send({ type: "cancel", action: id });
      await exactlyOne(c, id, f, 500);
      f.expect(out.end === "done", `the done probe was ${out.end}`);
      c.close();
    },
  },
  {
    id: "outcome.consent-timeout",
    what: "An action nobody agrees to ends cancelled with deadline; an agreed one runs",
    shared: true,
    async run(ctx, f) {
      const probe = need(ctx.profile.consent, "consent probe");
      const rule = ctx.hello.capabilities?.consent?.verbs?.[probe.verb];
      if (!rule) throw new Skip(`${probe.verb} needs no consent`);
      const c = await ctx.joined();
      const id = Client.id("consent");
      c.send(act(probe, { id }));
      const waiting = await c.waitFor((m) => m.id === id && m.type === "waiting", 10000, true).catch(() => undefined);
      f.expect(waiting, "no waiting state was sent");
      const out = await waitFinal(c, id, rule.seconds * 1000 + 10000);
      f.expect(out.end === "cancelled" && out.reason?.code === "deadline", `nobody agreed and it was ${out.end} ${out.reason?.code ?? ""}`);
      await exactlyOne(c, id, f);
      const owner = await ctx.joined(need(ctx.profile.owner, "owner role"));
      const id2 = Client.id("agreed");
      c.send(act(probe, { id: id2 }));
      const w2 = await c.waitFor((m) => m.id === id2 && m.type === "waiting", 10000, true);
      const agreed = await owner.request({ type: "consent", act: w2.act, agree: true });
      f.expect(agreed.end === "done", `the owner's consent was ${agreed.end} ${agreed.reason?.code ?? ""}`);
      const out2 = await waitFinal(c, id2, 10000);
      f.expect(out2.end === "done", `an agreed action was ${out2.end} ${out2.reason?.code ?? ""}`);
      await exactlyOne(c, id2, f);
      owner.close();
      c.close();
    },
  },
  {
    id: "idempotency.repeat",
    what: "One ID sent three times has one effect and three identical answers",
    async run(ctx, f) {
      const probe = need(ctx.profile.counter, "counter probe");
      const c = await ctx.joined(undefined, { key: true });
      const value = async () => thingOf(await observe(c), probe.object!)?.[probe.property];
      const v0 = await value();
      const id = Client.id("repeat");
      const answers: Record<string, any>[] = [];
      for (let i = 0; i < 3; i++) answers.push(await c.request(act(probe, { id })));
      const v1 = await value();
      await c.request(act(probe));
      const v2 = await value();
      f.expect(answers.every((a) => isDeepStrictEqual(a, answers[0])), `the three answers differ: ${answers.map((a) => JSON.stringify(a)).join(" / ")}`);
      f.expect(answers[0].end === "done", `the counter probe was ${answers[0].end}`);
      f.expect(isDeepStrictEqual(v1 - v0, v2 - v1), `one ID sent three times changed ${probe.property} by ${v1 - v0}; one action changes it by ${v2 - v1}`);
      const entries = await recordFrom(c, c.joined!.head);
      f.expect(entries.filter((e) => e.type === "asp.outcome" && e.data?.id === id).length === 1, "the record does not hold the action exactly once");
      c.close();
    },
  },
  {
    id: "stale.basis",
    what: "An action with an old basis is refused with stale; a current one is done; a future one is malformed",
    async run(ctx, f) {
      const probe = need(ctx.profile.stale, "stale probe");
      const c = await ctx.joined();
      const s0 = (await observe(c)).seq;
      const first = await c.request(act(probe, { basis: s0 }));
      f.expect(first.end === "done", `with a current basis it was ${first.end} ${first.reason?.code ?? ""}`);
      const second = await c.request(act(probe, { basis: s0 }));
      f.expect(second.end === "refused" && second.reason?.code === "stale", `with a stale basis it was ${second.end} ${second.reason?.code ?? ""}`);
      const s1 = (await observe(c)).seq;
      const third = await c.request(act(probe, { basis: s1 }));
      f.expect(third.end === "done", `with a fresh basis it was ${third.end} ${third.reason?.code ?? ""}`);
      const future = await c.request(act(probe, { basis: s1 + 100000 }));
      f.expect(future.end === "refused" && future.reason?.code === "malformed", `with a basis beyond the head it was ${future.end} ${future.reason?.code ?? ""}`);
      c.close();
    },
  },
  {
    id: "atomic.constraint",
    what: "A change that breaks a constraint takes no effect; state and record are unchanged",
    async run(ctx, f) {
      const probe = need(ctx.profile.constraint, "constraint probe");
      const isEdit = "changes" in probe;
      const c = await ctx.joined(isEdit ? ctx.profile.owner : undefined);
      const before = await observe(c);
      const id = Client.id("atomic");
      const message = isEdit ? { type: "edit", id, changes: (probe as { changes: unknown[] }).changes } : act(probe as Probe, { id });
      const out = await c.request(message);
      f.expect(out.end === "refused" && out.reason?.code === "constraint", `breaking a constraint was ${out.end} ${out.reason?.code ?? ""}`);
      const after = await observe(c);
      f.expect(isDeepStrictEqual(normalize(before.structure), normalize(after.structure)), "the state changed although the change was refused");
      const entries = await recordFrom(c, before.seq + 1);
      const others = entries.filter((e) => !((e.type === "asp.act" || e.type === "asp.edit" || e.type === "asp.outcome") && e.data?.id === id));
      const caused = others.filter((e) => e.source === `presence/${c.joined!.presence}`);
      f.expect(caused.length === 0, `the record gained ${caused.map((e) => e.type).join(", ")} besides the action and its outcome`);
      c.close();
    },
  },
  {
    id: "record.once",
    what: "Every outcome and event is pushed exactly once, in order, and matches the record",
    async run(ctx, f) {
      const c = await ctx.joined();
      const sub = await c.request({ type: "subscribe" });
      f.expect(sub.type === "subscribed", `subscribe got ${sub.type}`);
      const outs = [];
      for (const p of [ctx.profile.done, ctx.profile.counter, ctx.profile.done].filter(Boolean) as Probe[]) outs.push(await c.request(act(p)));
      outs.push(await c.request({ type: "act", verb: "x.inspector.nothing" }));
      await c.quiet(500);
      const pushed = c.messages.filter((m) => m.type === "event").map((m) => m.entry);
      const seqs = pushed.map((e) => e.seq);
      f.expect(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), "pushed entries are not in increasing order");
      f.expect(new Set(seqs).size === seqs.length, "an entry was pushed twice");
      for (const o of outs) {
        if (o.seq === undefined) {
          f.expect(false, `outcome ${o.id} has no seq`);
          continue;
        }
        f.expect(seqs.filter((s) => s === o.seq).length === 1, `outcome ${o.id} at ${o.seq} was not pushed exactly once`);
        for (const ev of o.events ?? []) f.expect(seqs.includes(ev), `event ${ev} of ${o.id} was not pushed`);
      }
      const entries = await recordFrom(c, sub.from);
      const recorded = entries.filter((e) => e.seq <= Math.max(...seqs)).map((e) => e.seq);
      f.expect(isDeepStrictEqual(recorded, seqs), `pushed ${seqs.join(",")} but the record has ${recorded.join(",")}`);
      c.close();
    },
  },
  {
    id: "record.resume",
    what: "After a disconnect, resuming by sequence number loses and repeats nothing; an action under way across the drop has exactly one outcome",
    shared: true,
    async run(ctx, f) {
      const probe = need(ctx.profile.counter, "counter probe");
      const slow = need(ctx.profile.slow, "slow probe");
      const a = await ctx.joined(undefined, { key: true });
      const resumeToken = a.joined!.resume;
      await a.request({ type: "subscribe" });
      const b = await ctx.joined();
      await b.request(act(probe));
      // An action that is under way when the connection drops and ends while it is down.
      const id = Client.id("across");
      a.send(act(slow, { id, deadline: 1 }));
      await a.waitFor((m) => m.id === id, 5000);
      await a.quiet(200);
      const before = a.messages.filter((m) => m.type === "event").map((m) => m.entry.seq);
      const lastSeen = before.length ? before[before.length - 1] : a.joined!.head;
      a.drop();
      for (let i = 0; i < 3; i++) await b.request(act(probe));
      await new Promise((r) => setTimeout(r, 1500));
      const grace = ctx.hello.capabilities?.participants?.grace_seconds ?? 300;
      const again = await ctx.client({ key: a.key });
      if (grace > 0) {
        const res = await again.join({ resume: resumeToken });
        f.expect(res.resumed === true && res.presence === a.joined!.presence, "the presence was not resumed");
      } else {
        await again.join({ role: ctx.profile.role });
        f.note("grace_seconds is 0: resumed with a new presence");
      }
      const sub = await again.request({ type: "subscribe", from: lastSeen + 1 });
      f.expect(sub.type === "subscribed", `subscribing from ${lastSeen + 1} got ${sub.type} ${sub.reason?.code ?? ""}`);
      await again.quiet(600);
      const pushed = again.messages.filter((m) => m.type === "event").map((m) => m.entry);
      const after = pushed.map((e) => e.seq);
      const all = [...before, ...after];
      f.expect(new Set(all).size === all.length, `entries were repeated: ${all.join(",")}`);
      const recorded = (await recordFrom(again, lastSeen + 1)).map((e) => e.seq).filter((s) => s <= Math.max(...after, lastSeen));
      const lost = recorded.filter((s) => !after.includes(s));
      f.expect(lost.length === 0, `entries ${lost.join(",")} were lost on resuming`);
      const outcomes = (await recordFrom(again, lastSeen + 1)).filter((e) => e.type === "asp.outcome" && e.data?.id === id);
      f.expect(outcomes.length === 1, `the action under way across the drop has ${outcomes.length} outcomes in the record`);
      const delivered = pushed.filter((e) => e.type === "asp.outcome" && e.data?.id === id);
      f.expect(delivered.length === 1, `its outcome was pushed ${delivered.length} times after resuming`);
      again.close();
      b.close();
    },
  },
  {
    id: "record.expired",
    what: "Queries from before the earliest entry kept are refused with expired",
    async run(ctx, f) {
      const keep = ctx.hello.record?.keep_seconds;
      if (keep === null || keep === undefined || keep > 30) throw new Skip(`the record is kept ${keep == null ? "for ever" : `${keep} s`}`);
      const probe = need(ctx.profile.done, "done probe");
      const c = await ctx.joined();
      const old = (await c.request(act(probe))).seq ?? c.joined!.head;
      const deadline = Date.now() + (keep + 10) * 1000;
      let earliest = 0;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        await c.request(act(probe));
        const probeHello = await ctx.client();
        earliest = probeHello.hello!.record.earliest;
        probeHello.close();
        if (earliest > old) break;
      }
      f.expect(earliest > old, `entry ${old} was still kept ${keep + 10} s later`);
      const r = await c.request({ type: "record", from: old });
      f.expect(r.type === "outcome" && r.end === "refused" && r.reason?.code === "expired", `a record query from ${old} got ${r.type} ${r.reason?.code ?? ""}, not refused expired`);
      const s = await c.request({ type: "subscribe", from: old });
      f.expect(s.type === "outcome" && s.end === "refused" && s.reason?.code === "expired", `a subscription from ${old} got ${s.type} ${s.reason?.code ?? ""}, not refused expired`);
      c.close();
    },
  },
  {
    id: "projection.roles",
    what: "What each role sees in observations and the record matches its declaration",
    async run(ctx, f) {
      const all = roles(ctx.hello);
      if (ctx.profile.counter) {
        const c = await ctx.joined();
        await c.request(act(ctx.profile.counter));
        c.close();
      }
      let tried = 0;
      for (const [role, r] of Object.entries<any>(all)) {
        let c: Client;
        try {
          c = await ctx.joined(role);
        } catch (e) {
          f.note(`could not join as ${role}: ${(e as Error).message}`);
          continue;
        }
        tried++;
        const hide = r.hide ?? {};
        const o = await observe(c);
        for (const t of o.structure.things ?? []) {
          for (const p of hide.properties ?? []) f.expect(!(p in t) || p === "id" || p === "type", `${role} sees ${t.id}.${p}`);
        }
        const from = Math.max(1, c.joined!.head - 300, c.hello!.record?.earliest ?? 1);
        const entries = await recordFrom(c, from, true);
        for (const e of entries) {
          f.expect(!(hide.events ?? []).includes(e.type), `${role} receives ${e.type} at ${e.seq}`);
          f.expect(!e.roles || e.roles.includes(role), `${role} receives ${e.type} at ${e.seq}, meant for ${e.roles?.join(", ")}`);
          if (e.data && typeof e.data === "object") for (const p of hide.properties ?? []) f.expect(!(p in e.data), `${role} sees ${p} in ${e.type} at ${e.seq}`);
        }
        c.close();
      }
      if (!tried) throw new Skip("no role could be joined");
    },
  },
  {
    id: "projection.score",
    what: "Only the evaluator gets the score",
    shared: true,
    async run(ctx, f) {
      const ep = ctx.hello.capabilities?.episode;
      if (!ep) throw new Skip("episode is not declared");
      const evaluator = ep.evaluator ?? "evaluator";
      const c = await ctx.joined();
      const started = await c.request({ type: "episode", ...(ep.tasks?.[0] ? { task: ep.tasks[0] } : {}), seed: 1 });
      f.expect(started.end === "done", `starting an episode was ${started.end} ${started.reason?.code ?? ""}`);
      const denied = await c.request({ type: "score" });
      f.expect(denied.end === "refused" && denied.reason?.code === "forbidden", `${c.joined!.role} asking for the score got ${denied.end} ${denied.reason?.code ?? ""}`);
      const e = await ctx.joined(evaluator);
      const score = await e.request({ type: "score" });
      f.expect(score.end === "done" && score.result?.score !== undefined, `the evaluator asking for the score got ${score.end} ${score.reason?.code ?? ""}`);
      const mine = await recordFrom(c, c.joined!.head);
      f.expect(!mine.some((x) => x.type === "asp.score"), `${c.joined!.role} receives asp.score`);
      const theirs = await recordFrom(e, c.joined!.head);
      f.expect(theirs.some((x) => x.type === "asp.score"), "the evaluator does not receive asp.score");
      c.close();
      e.close();
    },
  },
  {
    id: "unsupported.all",
    what: "Undeclared capabilities, parts not negotiated, undeclared forms and unknown messages get a clear unsupported",
    async run(ctx, f) {
      const caps = ctx.hello.capabilities ?? {};
      const shapes: Record<string, Record<string, unknown>> = {
        edit: { changes: [] },
        stream: { form: "x.inspector.form" },
        consent: { act: 1, agree: true },
        snapshot: {},
        restore: { snapshot: "sha256:" + "0".repeat(64) },
        episode: {},
        score: {},
        pause: { action: "x" },
        resume: { action: "x" },
        sense: { op: "list" },
        views: {},
        offer: { door: "x" },
        take: { offer: "x" },
      };
      const expectUnsupported = async (c: Client, type: string, why: string) => {
        const out = await c.request({ type, ...shapes[type] }, 5000).catch(() => undefined);
        f.expect(out && out.type === "outcome" && out.end === "refused" && out.reason?.code === "unsupported", `${type} (${why}) got ${out ? `${out.type} ${out.end ?? ""} ${out.reason?.code ?? ""}` : "no answer"}`);
      };
      const full = await ctx.joined();
      let checked = 0;
      for (const [type, cap] of Object.entries(MESSAGE_CAPABILITY)) {
        if (caps[cap] === undefined) {
          await expectUnsupported(full, type, `capability ${cap} not declared`);
          checked++;
        }
      }
      const narrow = await ctx.client({ parts: { core: [ctx.hello.parts.core] } });
      await narrow.join({ role: ctx.profile.role });
      for (const [type, cap] of Object.entries(MESSAGE_CAPABILITY)) {
        if (cap === "edit" || caps[cap] === undefined) continue;
        await expectUnsupported(narrow, type, `part ${cap} not negotiated`);
        checked++;
      }
      narrow.close();
      const id = Client.id("form");
      const o = await full.request({ type: "observe", id, forms: ["x.inspector.form"] });
      f.expect(o.type === "outcome" && o.reason?.code === "unsupported", `observing an undeclared form got ${o.type} ${o.reason?.code ?? ""}`);
      const u = await full.request({ type: "x.inspector.ping" });
      f.expect(u.type === "outcome" && u.end === "refused" && u.reason?.code === "unsupported", `an unknown message type with an ID got ${u.type} ${u.reason?.code ?? ""}`);
      full.send({ type: "x.inspector.ping" });
      const err = await full.waitFor((m) => m.type === "error", 5000).catch(() => undefined);
      f.expect(err?.code === "unsupported", `an unknown message type without an ID got ${err ? `error ${err.code}` : "no answer"}`);
      f.note(`${checked} capability messages checked`);
      full.close();
    },
  },
  {
    id: "doors.handover",
    what: "An offer cut off midway leaves the thing on exactly one side; resent offers take it once; unknown types fall back",
    shared: true,
    async run(ctx, f) {
      const doors = ctx.hello.capabilities?.doors;
      if (!doors) throw new Skip("doors is not declared");
      const offer = ctx.profile.offer;
      if (doors.takes && offer) {
        const giver = await ctx.joined(undefined, { key: true });
        const suffix = Date.now().toString(36);
        const thing: Record<string, any> = { ...offer.thing, id: `${offer.thing.id}-${suffix}` };
        const o1 = Client.id("offer");
        giver.send({ type: "offer", id: o1, thing });
        giver.drop();
        const back = await ctx.joined(undefined, { key: giver.key });
        const asked = await back.request({ type: "take", offer: o1 });
        f.expect(asked.end === "done" && typeof asked.result?.taken === "boolean", `take got ${asked.end} ${asked.reason?.code ?? ""}`);
        const count = (o: Record<string, any>) => (o.structure.things ?? []).filter((t: any) => String(t.id).includes(thing.id)).length;
        const here = count(await observe(back));
        f.expect(here === (asked.result?.taken ? 1 : 0), `take says taken=${asked.result?.taken} but the space holds ${here} of it`);
        const resent = await back.request({ type: "offer", id: o1, thing });
        if (asked.result?.taken) f.expect(resent.end === "done" && resent.result?.take === asked.result.take, "resending a taken offer did not return the same take");
        else f.expect(resent.end === "refused", `an offer asked about before it was taken was later ${resent.end}`);
        f.expect(count(await observe(back)) === here, "resending the offer changed how many of the thing the space holds");
        const o2 = Client.id("offer");
        const thing2: Record<string, any> = { ...offer.thing, id: `${offer.thing.id}-b-${suffix}` };
        const first = await back.request({ type: "offer", id: o2, thing: thing2 });
        f.expect(first.end === "done", `a fresh offer was ${first.end} ${first.reason?.code ?? ""}`);
        const second = await back.request({ type: "offer", id: o2, thing: thing2 });
        f.expect(isDeepStrictEqual(first, second), "a resent offer got a different answer");
        const known = ((await back.request({ type: "vocabulary" })).vocabulary?.types ?? {}) as Record<string, unknown>;
        if (first.end === "done") {
          f.expect(known[first.result.as] !== undefined && [thing2.type, ...(thing2.parents ?? [])].includes(first.result.as), `the thing was taken as ${first.result.as}, not its nearest known type`);
        }
        if (offer.unknown) {
          const none = await back.request({ type: "offer", thing: { ...offer.unknown, id: `${offer.unknown.id}-${suffix}` } });
          f.expect(none.end === "refused" && none.reason?.code === "unsupported", `a thing of no known type was ${none.end} ${none.reason?.code ?? ""}`);
        }
        back.close();
      } else f.note("the space takes no things, or the profile has no offer");
      if (doors.doors?.length) {
        const traveller = await ctx.joined(undefined, { key: true });
        const out = await traveller.request({ type: "offer", door: doors.doors[0].thing });
        f.expect(out.end === "done" && typeof out.result?.pass === "string", `passing through ${doors.doors[0].thing} was ${out.end} ${out.reason?.code ?? ""}`);
        if (out.end === "done") {
          const payload = ctx.hello.key ? readPass(out.result.pass, ctx.hello.key) : undefined;
          f.expect(payload?.participant === traveller.key!.identity, "the pass is not signed by the space's key for this participant");
        }
        traveller.close();
      }
    },
  },
  {
    id: "outcome.close",
    what: "Closing: the action under way gets its outcome first, then asp.closing",
    launch: true,
    async run(ctx, f) {
      const probe = need(ctx.profile.slow, "slow probe");
      const c = await ctx.joined();
      const id = Client.id("closing");
      c.send(act(probe, { id }));
      await c.waitFor((m) => m.id === id, 5000).catch(() => undefined);
      const closing = ctx.launcher!.closeGracefully();
      await c.waitClosed(20000).catch(() => f.expect(false, "the connection did not close"));
      await closing;
      const order = c.messages.filter((m) => (m.id === id && m.type === "outcome") || (m.type === "event" && m.entry?.type === "asp.closing"));
      f.expect(order.length === 2 && order[0].type === "outcome" && order[1].type === "event", `got ${order.map((m) => (m.type === "event" ? m.entry.type : `${m.type} ${m.end}`)).join(", ") || "nothing"}, not the outcome and then asp.closing`);
      await ctx.launcher!.start();
    },
  },
  {
    id: "outcome.restart",
    what: "Killed and restarted: the action under way gets exactly one unknown with restarted",
    launch: true,
    async run(ctx, f) {
      const probe = need(ctx.profile.slow, "slow probe");
      const c = await ctx.joined(undefined, { key: true });
      const id = Client.id("killed");
      c.send(act(probe, { id }));
      await c.waitFor((m) => m.id === id, 5000).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 300));
      await ctx.launcher!.kill();
      await ctx.launcher!.start();
      const again = await ctx.joined(undefined, { key: c.key });
      const entries = await recordFrom(again, c.joined!.head);
      const outcomes = entries.filter((e) => e.type === "asp.outcome" && e.data?.id === id);
      f.expect(outcomes.length === 1, `the record holds ${outcomes.length} outcomes for the killed action`);
      f.expect(outcomes[0]?.data?.end === "unknown" && outcomes[0]?.data?.reason?.code === "restarted", `the killed action is ${outcomes[0]?.data?.end} ${outcomes[0]?.data?.reason?.code ?? ""} in the record`);
      const resent = await again.request(act(probe, { id }));
      f.expect(resent.end === "unknown" && resent.reason?.code === "restarted" && resent.seq === outcomes[0]?.seq, `resending its ID got ${resent.end} ${resent.reason?.code ?? ""}`);
      again.close();
    },
  },
];
