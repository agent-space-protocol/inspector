// The test participant: a minimal participant, written with the TypeScript SDK, that runs a fixed
// scenario against any space and reports each step. Used to test a space library the other way
// round, and in every pairing of SDKs. The Python SDK has the same scenario.
import { Participant, OutcomeError } from "@agent-space-protocol/sdk/participant";
import { generateKey } from "@agent-space-protocol/sdk/identity";
import { contentHash } from "@agent-space-protocol/sdk";
import type { Entry, Outcome } from "@agent-space-protocol/sdk/types";

type Step = { name: string; ok: boolean; note: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runTestParticipant(address: string, print = true): Promise<boolean> {
  const steps: Step[] = [];
  const step = async (name: string, fn: () => Promise<string | void>) => {
    try {
      const note = (await fn()) ?? "";
      steps.push({ name, ok: true, note });
    } catch (e) {
      steps.push({ name, ok: false, note: e instanceof OutcomeError ? e.message : (e as Error).message });
    }
    const s = steps[steps.length - 1];
    if (print) process.stdout.write(`${s.ok ? "✓ pass" : "✗ fail"} ${s.name.padEnd(28)} ${s.note}\n`);
  };
  const expect = (cond: unknown, text: string) => {
    if (!cond) throw new Error(text);
  };

  const key = generateKey();
  let p!: Participant;
  const events: Entry[] = [];
  let profile: Record<string, any> = {};
  const act = (probe: Record<string, any>, extra: Record<string, unknown> = {}) => p.act({ verb: probe.verb, object: probe.object, args: probe.args, ...extra });

  await step("connect and shake hands", async () => {
    p = await Participant.connect(address, { key, client: { name: "agent-space participant" } });
    expect(p.parts.core === 0, `core was negotiated as ${p.parts.core}`);
    profile = (p.hello as Record<string, any>)["inspector.profile"] ?? {};
    return `space ${p.hello.space.slice(0, 24)}…, parts ${Object.keys(p.parts).join(" ")}`;
  });
  if (!p) return report(steps, print);
  await step("join", async () => {
    const j = await p.join({ role: profile.role, presentation: { name: "test participant" } });
    expect(j.participant === key.identity, "the space does not know the participant's key");
    return `presence ${j.presence} as ${j.role}`;
  });
  await step("vocabulary matches its hash", async () => {
    const v = await p.vocabulary();
    expect(contentHash(v) === p.hello.vocabulary, `the vocabulary hashes to ${contentHash(v)}, hello says ${p.hello.vocabulary}`);
    return `${Object.keys(v.verbs ?? {}).length} verbs`;
  });
  await step("observe", async () => {
    const o = await p.observe();
    expect(Number.isInteger(o.seq), "the observation has no seq");
    return `${o.structure.things.length} things at ${o.seq}`;
  });
  await step("subscribe and act", async () => {
    p.on("event", (e) => events.push(e));
    await p.subscribe();
    const out = await act(profile.done).done;
    expect(out.end === "done", `the done probe was ${out.end}`);
    await sleep(300);
    expect(events.some((e) => e.seq === out.seq), `the outcome at ${out.seq} was not pushed`);
    return `done at ${out.seq}, ${events.length} events pushed`;
  });
  await step("a refusal", async () => {
    const out = await p.act({ verb: "x.test.nothing" }).done;
    expect(out.end === "refused" && out.reason?.code === "unsupported", `an unknown verb was ${out.end} ${out.reason?.code}`);
    return "refused unsupported";
  });
  await step("cancel", async () => {
    const pending = act(profile.slow);
    const updates: string[] = [];
    pending.onUpdate((u) => updates.push(u.type));
    await sleep(400);
    pending.cancel();
    const out = await pending.done;
    expect(["cancelled", "done", "unknown"].includes(out.end), `a cancelled action was ${out.end}`);
    return `${updates.join(" ")} → ${out.end}`;
  });
  await step("resend an ID", async () => {
    const id = p.nextId("same");
    const a = await act(profile.counter, { id }).done;
    const b = await p.request<Outcome>({ type: "act", id, verb: profile.counter.verb, object: profile.counter.object, args: profile.counter.args }).done;
    expect(JSON.stringify(a) === JSON.stringify(b), "a resent ID got a different answer");
    return `both ${a.end} at ${a.seq}`;
  });
  await step("drop, act meanwhile, resume", async () => {
    const reconnected = new Promise<void>((r) => p.on("reconnect", () => r()));
    const from = p.lastSeq;
    p.drop();
    await sleep(100);
    const meanwhile = act(profile.counter);
    await reconnected;
    const out = await meanwhile.done;
    expect(out.end === "done", `the action sent meanwhile was ${out.end} ${out.reason?.code ?? ""}`);
    await sleep(400);
    const record = await p.record({ from: from + 1 });
    const seqs = events.filter((e) => e.seq > from).map((e) => e.seq);
    const recorded = record.entries.map((e) => e.seq).filter((s) => s <= Math.max(...seqs));
    expect(JSON.stringify(seqs) === JSON.stringify(recorded), `received ${seqs.join(",")} but the record has ${recorded.join(",")}`);
    const outcomes = record.entries.filter((e) => e.type === "asp.outcome" && (e.data as Record<string, unknown>)?.id === meanwhile.id);
    expect(outcomes.length === 1, `the action has ${outcomes.length} outcomes in the record`);
    return `resumed; ${seqs.length} entries after ${from}, none lost or repeated`;
  });
  await step("leave", async () => {
    const out = await p.leave();
    expect(out.end === "done", `leave was ${out.end}`);
  });
  p.close();
  return report(steps, print);
}

function report(steps: Step[], print: boolean): boolean {
  const failed = steps.filter((s) => !s.ok).length;
  if (print) process.stdout.write(`\n${steps.length - failed} passed, ${failed} failed\n`);
  return failed === 0;
}
