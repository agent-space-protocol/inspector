// The vocabulary and capabilities of the test space: a minimal space that declares every capability.
import type { Capabilities, Vocabulary } from "@agent-space-protocol/sdk/types";

export const vocabulary: Vocabulary = {
  namespaces: {
    test: { version: "0.1.0", line: "The conformance test space: a lamp, a counter, a box of balls, a safe and a door." },
  },
  types: {
    "test.thing": { line: "Anything in the test space." },
    "test.lamp": { parent: "test.thing", line: "A lamp that is on or off.", properties: { type: "object", properties: { on: { type: "boolean" } } } },
    "test.counter": { parent: "test.thing", line: "A counter that only adds up.", properties: { type: "object", properties: { value: { type: "integer" } } } },
    "test.box": { parent: "test.thing", line: "A box that holds at most `capacity` balls.", properties: { type: "object", properties: { capacity: { type: "integer", minimum: 0 } } } },
    "test.ball": { parent: "test.thing", line: "A ball, in a box or loose." },
    "test.safe": { parent: "test.thing", line: "A safe whose code guests may not see.", properties: { type: "object", properties: { code: { type: "string" } } } },
    "test.door": { parent: "test.thing", line: "A door to another space." },
  },
  relations: {
    "test.in": { from: "test.ball", to: "test.box", many: "one", line: "A ball is in a box." },
  },
  verbs: {
    "test.toggle": {
      line: "Switch a lamp on or off.",
      object: "test.lamp",
      effect: "change",
      outcomes: ["done", "refused"],
      reasons: ["stale", "test.no_such_thing"],
      default: { end: "done" },
      stale: "refuse",
    },
    "test.add": {
      line: "Add n to a counter.",
      object: "test.counter",
      params: { type: "object", properties: { n: { type: "integer", minimum: 1 } }, required: ["n"] },
      effect: "change",
      default: { end: "done" },
      stale: "allow",
    },
    "test.wait": {
      line: "Wait a number of seconds, reporting progress; stops when cancelled.",
      params: { type: "object", properties: { seconds: { type: "number", minimum: 0, maximum: 3600 } }, required: ["seconds"] },
      effect: "read",
      outcomes: ["done", "failed", "cancelled", "unknown"],
      default: { end: "done" },
    },
    "test.pack": {
      line: "Put balls into a box, all or none.",
      object: "test.box",
      params: { type: "object", properties: { balls: { type: "array", items: { type: "string" }, minItems: 1 } }, required: ["balls"] },
      effect: "change",
      outcomes: ["done", "refused"],
      reasons: ["constraint", "test.no_such_thing"],
      default: { end: "done" },
    },
    "test.launch": {
      line: "Launch something that cannot be undone; waits for the owner's consent.",
      effect: "irreversible",
      default: { end: "done" },
    },
    "test.paint": {
      line: "Paint a thing; only the owner may.",
      object: "test.thing",
      params: { type: "object", properties: { color: { type: "string" } }, required: ["color"] },
      effect: "change",
      default: { end: "refused", reason: { code: "test.nothing_to_paint", text: "nothing to paint" } },
    },
  },
  events: {
    "test.switched": { line: "A lamp was switched.", data: { type: "object", properties: { on: { type: "boolean" } } }, perceived: "all" },
    "test.added": { line: "A counter went up.", data: { type: "object", properties: { value: { type: "integer" } } }, perceived: "all" },
    "test.packed": { line: "Balls were put into a box." },
    "test.launched": { line: "Something was launched." },
    "test.painted": { line: "A thing was painted." },
    "test.changed": { line: "The world was edited." },
    "test.arrived": { line: "A thing arrived through a door." },
  },
  constraints: {
    "test.capacity": { line: "A box holds at most its capacity of balls." },
    "test.one_place": { line: "A ball is in at most one box." },
  },
  forms: {
    text: { media: "text/plain", line: "The space described in one paragraph." },
    "test.ticks": { media: "text/plain", continuous: true, line: "A tick every 1/rate seconds." },
  },
  pages: {
    test: [
      "# The test space",
      "",
      "A minimal space for conformance tests. It holds a lamp (`lamp:1`), a counter (`counter:1`),",
      "a box (`box:1`, capacity 2) with `ball:1` in it, two loose balls (`ball:2`, `ball:3`), a safe",
      "(`safe:1`) whose code guests do not see, and a door (`door:east`).",
      "",
      "- `test.toggle lamp:1` switches the lamp; it refuses stale actions.",
      "- `test.add counter:1 {n}` adds to the counter.",
      "- `test.wait {seconds}` waits and reports progress; cancel it to stop it.",
      "- `test.pack box:1 {balls}` puts balls into the box, all or none (`test.capacity`).",
      "- `test.launch` waits for the owner's consent.",
      "- `test.paint <thing> {color}` is for the owner only.",
    ].join("\n"),
  },
};

export function capabilities(options: { doorTo: string; doorSpace?: string; grace: number }): Capabilities {
  return {
    state: "held",
    lifetime: "lasting",
    participants: {
      max: 64,
      outside: true,
      grace_seconds: options.grace,
      default_role: "member",
      roles: {
        owner: { line: "May do and see everything, edit, and consent.", verbs: ["*"], edit: true, consent: true },
        member: { line: "May use every verb but test.paint.", verbs: ["test.toggle", "test.add", "test.wait", "test.pack", "test.launch"] },
        guest: { line: "May only look; does not see the safe's code or the counter's events.", verbs: [], hide: { properties: ["code"], events: ["test.added"] } },
        evaluator: { line: "Looks and takes scores.", verbs: [] },
      },
    },
    forms: ["text", "test.ticks"],
    inputs: ["text/plain"],
    edit: { roles: ["owner"], changes: ["add", "set", "remove", "relate", "unrelate"], sentences: false },
    snapshot: { restore: true },
    episode: { tasks: ["light"], evaluator: "evaluator" },
    pace: { max_hz: 50, clock: "wall" },
    consent: { verbs: { "test.launch": { by: "owner", seconds: 1 } } },
    pause: { verbs: ["test.wait"] },
    senses: { languages: ["test.path"], max: 8 },
    views: { count: 1 },
    doors: { takes: true, doors: [{ thing: "door:east", to: options.doorTo, ...(options.doorSpace ? { space: options.doorSpace } : {}) }] },
  };
}

/** The profile the runner uses on the test space; also sent in `hello` as `inspector.profile`. */
export const profile = {
  role: "member",
  owner: "owner",
  done: { verb: "test.toggle", object: "lamp:1" },
  counter: { verb: "test.add", object: "counter:1", args: { n: 1 }, property: "value" },
  slow: { verb: "test.wait", args: { seconds: 30 } },
  stale: { verb: "test.toggle", object: "lamp:1" },
  constraint: { verb: "test.pack", object: "box:1", args: { balls: ["ball:2", "ball:3"] } },
  consent: { verb: "test.launch" },
  offer: { thing: { id: "parcel:1", type: "test.parcel", parents: ["test.ball", "test.thing"] }, unknown: { id: "blob:1", type: "elsewhere.blob", parents: ["elsewhere.thing"] } },
};
