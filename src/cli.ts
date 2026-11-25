#!/usr/bin/env node
// The agent-space command.
import { parseArgs } from "node:util";
import { check } from "./check/runner.ts";
import { runTestSpace } from "./test-space/main.ts";
import { runTestParticipant } from "./test-participant/participant.ts";
import { runTui } from "./tui/tui.ts";

const HELP = `agent-space: inspect any Agent Space Protocol space

usage:
  agent-space check <address> [--profile <file>] [--launch <command>] [--json <file>] [--only <test,...>]
      Run the conformance tests against a space and report each as passed, failed or skipped.
      --launch starts the space with this command (which must close gracefully when its standard
      input ends), so that the closing and restart tests can run.

  agent-space tui <address> [--role <role>] [--key <file>] [--script <file>] [--plain]
      A terminal client: shows any space as things, relations and a stream of events, and lets you
      enter, observe, act, edit and cancel. Type "help" inside it.

  agent-space participant <address>
      The test participant: runs a fixed scenario against a space and reports each step.

  agent-space test-space [--listen <address>] [--data <dir>] [--keep-seconds <n>] [--grace <n>]
                         [--variant <name>] [--close-on-eof]
      The test space, a minimal space that declares every capability. --variant starts a broken
      variant: drop-outcome, run-twice, half-commit, drop-on-resume, silent-unsupported.

An address is a ws:// or http:// URL, or a command that starts a space on standard input and output.`;

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "check": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { profile: { type: "string" }, launch: { type: "string" }, json: { type: "string" }, only: { type: "string" }, quiet: { type: "boolean" } },
      });
      if (!positionals[0]) throw new Error("check needs an address");
      const report = await check({ address: positionals[0], profile: values.profile, launch: values.launch, json: values.json, only: values.only?.split(","), quiet: values.quiet });
      return report.summary.failed ? 1 : 0;
    }
    case "tui": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { role: { type: "string" }, key: { type: "string" }, script: { type: "string" }, plain: { type: "boolean" }, delay: { type: "string" } },
      });
      if (!positionals[0]) throw new Error("tui needs an address");
      await runTui({ address: positionals[0], role: values.role, keyFile: values.key, script: values.script, plain: values.plain, delayMs: values.delay ? Number(values.delay) : undefined });
      return 0;
    }
    case "participant": {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
      if (!positionals[0]) throw new Error("participant needs an address");
      return (await runTestParticipant(positionals[0])) ? 0 : 1;
    }
    case "test-space": {
      const { values } = parseArgs({
        args: rest,
        options: {
          listen: { type: "string", default: "ws://127.0.0.1:7777" },
          data: { type: "string" },
          "keep-seconds": { type: "string" },
          grace: { type: "string" },
          variant: { type: "string" },
          "close-on-eof": { type: "boolean" },
          "door-to": { type: "string" },
          "door-space": { type: "string" },
        },
      });
      await runTestSpace({
        listen: values.listen!,
        data: values.data,
        keepSeconds: values["keep-seconds"] ? Number(values["keep-seconds"]) : null,
        grace: values.grace ? Number(values.grace) : undefined,
        variant: values.variant,
        closeOnEof: values["close-on-eof"],
        doorTo: values["door-to"],
        doorSpace: values["door-space"],
      });
      return -1;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      console.error(`unknown command ${command}\n\n${HELP}`);
      return 2;
  }
}

main().then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (e) => {
    console.error(`agent-space: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  },
);
